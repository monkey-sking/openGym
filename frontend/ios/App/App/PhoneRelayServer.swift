import Foundation
import Network
import Darwin

// The phone acting as the openGym video-sync LAN relay. Ported from the menu-bar relay in
// tools/video-sync-extension/macos/main.swift (same HTTP + SSE shapes, same Bonjour advertisement)
// and the pairing contract in tools/video-sync-extension/local-server.mjs (/pair/code,
// /pair/register, /pair/verify). Kept in its own file so the Capacitor plugin stays readable.
//
// One important difference from the menu-bar relay: here the phone polls its OWN state over
// GET /api/video-sync/state (that is how the app half works). So a state poll must mark the
// PHONE as seen, never the extension — otherwise the phone would keep the workout paused forever
// believing a browser is connected. Only a real extension SSE stream, a `by: "video"` command, or
// an explicit `?role=extension` health/state probe marks the extension as connected.

let phoneRelayDefaultPort: UInt16 = 8787
let phoneRelayBonjourName = "openGym Video Sync"
let phoneRelayBonjourType = "_opengym._tcp"
// How recently the extension must have been heard from for extensionConnected to stay true.
private let extensionStaleMilliseconds = 15_000
// The pairing registry charset, matching tools/video-sync-extension/pairing.mjs exactly.
private let pairingCharset = Array("23456789ABCDEFGHJKMNPQRSTUVWXYZ")

typealias RelayJSON = [String: Any]

/// What a caller needs to point at the running server.
struct ServerInfo {
    let port: UInt16
    let ips: [String]
    let primaryIP: String?
}

private func relayNowMilliseconds() -> Int {
    Int((Date().timeIntervalSince1970 * 1_000).rounded())
}

private func relayJSONData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
}

private func relayJSONString(_ object: Any) -> String {
    String(decoding: relayJSONData(object), as: UTF8.self)
}

private func relayString(_ value: Any?) -> String? {
    guard let string = value as? String else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func relayFiniteDouble(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
}

/// The LAN IPv4 addresses of this device, loopback excluded. iOS port of main.swift:41.
func phoneRelayLanIPv4Addresses() -> [String] {
    var pointer: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
    defer { freeifaddrs(pointer) }

    var candidates: [(ip: String, ifName: String, priority: Int)] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let interface = cursor {
        defer { cursor = interface.pointee.ifa_next }
        guard let address = interface.pointee.ifa_addr,
              address.pointee.sa_family == UInt8(AF_INET) else { continue }
        let flags = Int32(interface.pointee.ifa_flags)
        guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }

        let ifName = String(cString: interface.pointee.ifa_name)
        // Skip VPN and tunnel virtual interfaces (utun*, ipsec*, ppp*)
        if ifName.hasPrefix("utun") || ifName.hasPrefix("ipsec") || ifName.hasPrefix("ppp") {
            continue
        }

        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let result = getnameinfo(
            address,
            socklen_t(address.pointee.sa_len),
            &host,
            socklen_t(host.count),
            nil,
            0,
            NI_NUMERICHOST
        )
        if result == 0 {
            let ip = String(cString: host)
            // Filter CGNAT/tunnel proxies (e.g. 198.19.x.x)
            if ip.hasPrefix("198.19.") { continue }

            var priority = 100
            if ifName == "en0" {
                priority = 10
            } else if ip.hasPrefix("192.168.") {
                priority = 20
            } else if ip.hasPrefix("172.20.10.") {
                // iPhone Personal Hotspot
                priority = 30
            } else if ip.hasPrefix("10.") {
                priority = 40
            }
            candidates.append((ip, ifName, priority))
        }
    }
    // Sort by priority ascending, then IP string
    candidates.sort { a, b in
        if a.priority != b.priority { return a.priority < b.priority }
        return a.ip < b.ip
    }
    var seen = Set<String>()
    var unique: [String] = []
    for item in candidates {
        if !seen.contains(item.ip) {
            seen.insert(item.ip)
            unique.append(item.ip)
        }
    }
    return unique
}

/// Normalize a typed pairing code the way the pairing registry does.
func phoneRelayNormalizePairCode(_ raw: String?) -> String? {
    guard let raw = raw else { return nil }
    let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        .replacingOccurrences(of: "0", with: "O")
        .replacingOccurrences(of: "I", with: "1")
        .replacingOccurrences(of: "L", with: "1")
        .filter { $0.isLetter || $0.isNumber }
        .filter { "23456789ABCDEFGHJKMNPQRSTUVWXYZ".contains($0) }
    return cleaned.isEmpty ? nil : cleaned
}

private func phoneRelayGenerateCode(length: Int = 4) -> String {
    String((0..<length).map { _ in pairingCharset.randomElement()! })
}

private let phoneRelayPairCodeDefaultsKey = "ai.opengym.video-sync.pair-code"

private func phoneRelayLoadSavedPairCode() -> String? {
    guard let saved = UserDefaults.standard.string(forKey: phoneRelayPairCodeDefaultsKey) else { return nil }
    return phoneRelayNormalizePairCode(saved)
}

private func phoneRelaySavePairCode(_ code: String) {
    UserDefaults.standard.set(code, forKey: phoneRelayPairCodeDefaultsKey)
}

final class PhoneRelayServer {
    enum StartResult {
        case success(ServerInfo)
        case failure(String)
    }

    private let queue = DispatchQueue(label: "ai.opengym.video-sync.phone-relay")
    private let epoch = UUID().uuidString.lowercased()
    private var listener: NWListener?
    private var heartbeat: DispatchSourceTimer?
    private var boundPort: UInt16?
    private var isReady = false

    private var streamClients: [UUID: NWConnection] = [:]
    private var connections: [UUID: NWConnection] = [:]
    private var requestBuffers: [UUID: Data] = [:]

    private var lastExtensionSeenAt = 0
    private var lastPhoneSeenAt = 0

    private(set) var pairCode: String = phoneRelayLoadSavedPairCode() ?? phoneRelayGenerateCode()

    private lazy var state: RelayJSON = [
        "epoch": epoch,
        "seq": 0,
        "action": NSNull(),
        "source": NSNull(),
        "sessionId": NSNull(),
        "videoUrl": NSNull(),
        "pos": NSNull(),
        "offset": 0,
        "force": false,
        "play": NSNull(),
        "online": false,
        "at": relayNowMilliseconds()
    ]

    // Start (idempotently) on `preferredPort`, falling back to a system-assigned port if it is
    // busy. The completion runs on the main queue.
    func start(preferredPort: UInt16, completion: @escaping (StartResult) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            if let port = self.boundPort, self.isReady {
                self.queue.async {
                    DispatchQueue.main.async { completion(.success(self.currentInfo(port: port))) }
                }
                return
            }
            self.startLocked(preferredPort: preferredPort, completion: completion)
        }
    }

    /// The current server info if it is already running, else nil. Used by discovery to fall back
    /// to the phone's own address.
    func readyInfo() -> ServerInfo? {
        var info: ServerInfo?
        queue.sync {
            if isReady, let port = boundPort { info = currentInfo(port: port) }
        }
        return info
    }

    /// Register (or set) the active pairing code. Returns the normalized code, or nil if invalid.
    @discardableResult
    func registerPairCode(_ raw: String) -> String? {
        guard let normalized = phoneRelayNormalizePairCode(raw) else { return nil }
        queue.sync {
            pairCode = normalized
            lastPhoneSeenAt = relayNowMilliseconds()
            phoneRelaySavePairCode(normalized)
        }
        return normalized
    }

    // MARK: - Listener lifecycle

    private func startLocked(preferredPort: UInt16, retryCount: Int = 0, completion: @escaping (StartResult) -> Void) {
        stopLocked()
        let targetPort = preferredPort != 0 ? preferredPort : phoneRelayDefaultPort
        guard let port = NWEndpoint.Port(rawValue: targetPort) else {
            DispatchQueue.main.async { completion(.failure("Invalid relay port.")) }
            return
        }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true

        guard let listener = try? NWListener(using: parameters, on: port) else {
            if retryCount < 4 {
                queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.startLocked(preferredPort: targetPort, retryCount: retryCount + 1, completion: completion)
                }
            } else {
                DispatchQueue.main.async {
                    completion(.failure("The phone's video-sync server could not bind port \(targetPort)."))
                }
            }
            return
        }
        configureAndStart(listener: listener, targetPort: targetPort, retryCount: retryCount, completion: completion)
    }

    private func configureAndStart(listener: NWListener, targetPort: UInt16, retryCount: Int, completion: @escaping (StartResult) -> Void) {
        self.listener = listener
        listener.service = NWListener.Service(
            name: phoneRelayBonjourName,
            type: phoneRelayBonjourType,
            domain: "local."
        )
        listener.stateUpdateHandler = { [weak self] newState in
            guard let self else { return }
            switch newState {
            case .ready:
                guard let port = listener.port?.rawValue else { return }
                self.boundPort = port
                self.isReady = true
                let info = self.currentInfo(port: port)
                DispatchQueue.main.async { completion(.success(info)) }
            case .waiting:
                // Normal transient state while network interfaces are acquiring addresses.
                // Do NOT cancel the listener here.
                break
            case .failed(let error):
                // Never fall back to dynamic random port 0, because the Chrome extension sweeps
                // fixed port 8787 across the LAN and cannot discover random ephemeral ports.
                listener.stateUpdateHandler = nil
                listener.service = nil
                listener.cancel()
                self.listener = nil
                if retryCount < 4 {
                    self.queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        self?.startLocked(preferredPort: targetPort, retryCount: retryCount + 1, completion: completion)
                    }
                } else {
                    DispatchQueue.main.async {
                        completion(.failure("Port \(targetPort) failed: \(error.localizedDescription)"))
                    }
                }
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
    }

    private func stopLocked() {
        heartbeat?.cancel()
        heartbeat = nil
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.service = nil
        listener?.cancel()
        listener = nil
        boundPort = nil
        isReady = false
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        requestBuffers.removeAll()
        streamClients.removeAll()
    }

    private func currentInfo(port: UInt16) -> ServerInfo {
        let ips = phoneRelayLanIPv4Addresses()
        return ServerInfo(port: port, ips: ips, primaryIP: ips.first)
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        let id = UUID()
        connections[id] = connection
        connection.stateUpdateHandler = { [weak self] newState in
            guard let self else { return }
            switch newState {
            case .failed, .cancelled:
                self.dropConnection(id)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(id: id)
    }

    private func dropConnection(_ id: UUID) {
        streamClients.removeValue(forKey: id)?.cancel()
        connections.removeValue(forKey: id)?.cancel()
        requestBuffers.removeValue(forKey: id)
    }

    private func receive(id: UUID) {
        guard let connection = connections[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                var buffer = self.requestBuffers[id] ?? Data()
                buffer.append(data)
                self.requestBuffers[id] = buffer
                if self.parseRequest(id: id, buffer: buffer) { return }
            }
            if complete || error != nil {
                self.dropConnection(id)
                return
            }
            self.receive(id: id)
        }
    }

    private func parseRequest(id: UUID, buffer: Data) -> Bool {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerRange = buffer.range(of: separator) else {
            if buffer.count > 64 * 1_024 {
                sendJSON(id: id, status: 431, object: ["error": "request headers too large"])
            }
            return false
        }

        let headerData = buffer[..<headerRange.lowerBound]
        guard let header = String(data: headerData, encoding: .utf8) else {
            sendJSON(id: id, status: 400, object: ["error": "invalid request headers"])
            return true
        }
        let lines = header.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            sendJSON(id: id, status: 400, object: ["error": "invalid request"])
            return true
        }
        let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else {
            sendJSON(id: id, status: 400, object: ["error": "invalid request line"])
            return true
        }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        let contentLength = max(0, Int(headers["content-length"] ?? "0") ?? 0)
        guard contentLength <= 1_048_576 else {
            sendJSON(id: id, status: 413, object: ["error": "request body too large"])
            return true
        }
        let bodyStart = headerRange.upperBound
        guard buffer.count >= bodyStart + contentLength else { return false }

        let body = buffer.subdata(in: bodyStart..<(bodyStart + contentLength))
        handle(method: parts[0].uppercased(), target: parts[1], headers: headers, body: body, id: id)
        return true
    }

    private func handle(method: String, target: String, headers: [String: String], body: Data, id: UUID) {
        let origin = headers["host"].flatMap { URL(string: "http://\($0)") } ?? URL(string: "http://localhost")!
        let components = URLComponents(string: target) ?? URLComponents(url: origin, resolvingAgainstBaseURL: false)
        var path = components?.path ?? "/"
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/" }
        let query = components?.queryItems ?? []
        let codeParam = query.first { $0.name == "code" }?.value
        let roleParam = query.first { $0.name == "role" }?.value?.lowercased()

        if method == "OPTIONS" {
            sendEmpty(id: id, status: 204)
            return
        }

        if method == "GET", path == "/health" {
            let info = connectionInfo()
            var payload: RelayJSON = [
                "ok": true,
                "version": 1,
                "relayKind": "phone-native-lan",
                "port": boundPort.map { Int($0) } ?? NSNull(),
                "ips": phoneRelayLanIPv4Addresses(),
                "url": primaryLanUrl(),
                "pairCode": pairCode,
                "state": state
            ]
            if roleParam == "extension" {
                lastExtensionSeenAt = relayNowMilliseconds()
            }
            for (key, value) in info { payload[key] = value }
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }

        if method == "GET", path == "/pair/code" {
            let payload: RelayJSON = [
                "ok": true,
                "code": pairCode,
                "ips": phoneRelayLanIPv4Addresses(),
                "port": boundPort.map { Int($0) } ?? NSNull(),
                "url": primaryLanUrl()
            ]
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }

        if (method == "POST" && path == "/pair/code") || (method == "GET" && path == "/pair/register") {
            var code = codeParam
            if code == nil, method == "POST" {
                if let parsed = try? JSONSerialization.jsonObject(with: body.isEmpty ? Data("{}".utf8) : body),
                   let object = parsed as? RelayJSON {
                    code = relayString(object["code"])
                }
            }
            guard let normalized = phoneRelayNormalizePairCode(code) else {
                sendJSON(id: id, status: 400, object: ["ok": false, "error": "invalid_code"])
                return
            }
            pairCode = normalized
            phoneRelaySavePairCode(normalized)
            lastPhoneSeenAt = relayNowMilliseconds()
            let payload: RelayJSON = [
                "ok": true,
                "code": normalized,
                "ips": phoneRelayLanIPv4Addresses(),
                "port": boundPort.map { Int($0) } ?? NSNull(),
                "url": primaryLanUrl()
            ]
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }

        if method == "GET", path == "/pair/verify" {
            guard let normalized = phoneRelayNormalizePairCode(codeParam), normalized == pairCode else {
                sendJSON(id: id, status: 404, object: ["ok": false, "error": "invalid_or_expired_code"])
                return
            }
            lastPhoneSeenAt = relayNowMilliseconds()
            let payload: RelayJSON = [
                "ok": true,
                "code": normalized,
                "ips": phoneRelayLanIPv4Addresses(),
                "port": boundPort.map { Int($0) } ?? NSNull(),
                "url": primaryLanUrl()
            ]
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }

        if method == "GET", path == "/state" || path == "/api/video-sync/state" {
            // The phone polling its own state marks the PHONE seen, not the extension. A caller
            // that says role=extension is the extension and marks it.
            if roleParam == "extension" {
                lastExtensionSeenAt = relayNowMilliseconds()
            } else {
                lastPhoneSeenAt = relayNowMilliseconds()
            }
            let info = connectionInfo()
            var payload = state
            payload["online"] = info["extensionConnected"] ?? false
            for (key, value) in info { payload[key] = value }
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }

        if method == "GET", path == "/stream" || path == "/api/video-sync/stream" {
            openStream(id: id)
            return
        }

        if method == "POST", path == "/command" || path == "/api/video-sync/command" {
            let parsed: Any
            do {
                parsed = try JSONSerialization.jsonObject(with: body.isEmpty ? Data("{}".utf8) : body)
            } catch {
                sendJSON(id: id, status: 400, object: ["ok": false, "error": error.localizedDescription])
                return
            }
            guard let object = parsed as? RelayJSON else {
                sendJSON(id: id, status: 400, object: ["ok": false, "error": "body must be a JSON object"])
                return
            }
            sendJSON(id: id, status: 200, object: applyCommand(object))
            return
        }

        sendJSON(id: id, status: 404, object: ["error": "not found"])
    }

    private func primaryLanUrl() -> Any {
        guard let port = boundPort else { return NSNull() }
        let ip = phoneRelayLanIPv4Addresses().first ?? "127.0.0.1"
        return "http://\(ip):\(port)"
    }

    private func connectionInfo() -> RelayJSON {
        let now = relayNowMilliseconds()
        let extensionConnected = lastExtensionSeenAt > 0 && now - lastExtensionSeenAt <= extensionStaleMilliseconds
        let phoneConnected = lastPhoneSeenAt > 0 && now - lastPhoneSeenAt <= extensionStaleMilliseconds
        return [
            "clients": streamClients.count,
            "extensionConnected": extensionConnected,
            "phoneConnected": phoneConnected,
            "lastExtensionSeenAt": lastExtensionSeenAt > 0 ? lastExtensionSeenAt : NSNull(),
            "lastPhoneSeenAt": lastPhoneSeenAt > 0 ? lastPhoneSeenAt : NSNull(),
            "sessionId": state["sessionId"] ?? NSNull(),
            "action": state["action"] ?? NSNull(),
            "stateAt": state["at"] ?? now
        ]
    }

    private func applyCommand(_ body: RelayJSON) -> RelayJSON {
        let action = relayString(body["action"])
        let source = relayString(body["source"]) ?? "unknown"
        let by = relayString(body["by"])
        // A command the extension posts carries by:"video"; anything else is the phone.
        if by == "video" {
            lastExtensionSeenAt = relayNowMilliseconds()
        } else {
            lastPhoneSeenAt = relayNowMilliseconds()
        }

        let previousSeq = (state["seq"] as? Int) ?? 0
        let previousSessionID = state["sessionId"] as? String
        let previousVideoURL = state["videoUrl"] as? String
        let suppliedURL = relayString(body["videoUrl"])
        let namedURL = suppliedURL.flatMap { value -> String? in
            let lower = value.lowercased()
            return lower.hasPrefix("http://") || lower.hasPrefix("https://") ? value : nil
        }
        let nextSessionID: String?
        if action == "end" {
            nextSessionID = nil
        } else {
            nextSessionID = relayString(body["sessionId"]) ?? previousSessionID
        }
        let nextVideoURL: String?
        if action == "end" {
            nextVideoURL = nil
        } else if source == "video" || by == "video" {
            nextVideoURL = namedURL ?? previousVideoURL
        } else {
            nextVideoURL = namedURL
        }
        let nextPlay: Any
        if action == "start", let play = body["play"] as? Bool {
            nextPlay = play
        } else {
            nextPlay = NSNull()
        }

        var nextState: RelayJSON = [
            "epoch": epoch,
            "seq": previousSeq + 1,
            "action": action ?? NSNull(),
            "source": source,
            "sessionId": nextSessionID ?? NSNull(),
            "videoUrl": nextVideoURL ?? NSNull(),
            "pos": relayFiniteDouble(body["pos"]) ?? NSNull(),
            "offset": relayFiniteDouble(body["offset"]) ?? (state["offset"] as? Double) ?? 0,
            "force": body["force"] as? Bool ?? false,
            "play": nextPlay,
            "online": !streamClients.isEmpty,
            "at": relayNowMilliseconds()
        ]
        if let phoneMeta = body["phoneMeta"] as? RelayJSON {
            nextState["phoneMeta"] = phoneMeta
        } else if action != "end", let existing = state["phoneMeta"] {
            nextState["phoneMeta"] = existing
        }
        state = nextState
        broadcast(state)
        return state
    }

    private func openStream(id: UUID) {
        guard let connection = connections[id] else { return }
        let header = [
            "HTTP/1.1 200 OK",
            "Content-Type: text/event-stream",
            "Cache-Control: no-cache, no-transform",
            "Connection: keep-alive",
            "Access-Control-Allow-Origin: *",
            "X-Accel-Buffering: no",
            "",
            ""
        ].joined(separator: "\r\n")
        connection.send(content: Data(header.utf8), completion: .contentProcessed { _ in })

        streamClients[id] = connection
        lastExtensionSeenAt = relayNowMilliseconds()
        var initial = state
        initial["online"] = true
        sendSSE(connection, object: initial)
        startHeartbeatIfNeeded()
    }

    private func startHeartbeatIfNeeded() {
        guard heartbeat == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 20, repeating: 20)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            for connection in self.streamClients.values {
                connection.send(content: Data(": ping\n\n".utf8), completion: .contentProcessed { _ in })
            }
        }
        timer.resume()
        heartbeat = timer
    }

    private func broadcast(_ snapshot: RelayJSON) {
        for connection in streamClients.values {
            sendSSE(connection, object: snapshot)
        }
    }

    private func sendSSE(_ connection: NWConnection, object: RelayJSON) {
        let payload = "data: \(relayJSONString(object))\n\n"
        connection.send(content: Data(payload.utf8), completion: .contentProcessed { _ in })
    }

    private func sendJSON(id: UUID, status: Int, object: RelayJSON, cacheControl: String? = nil) {
        let payload = relayJSONData(object)
        var headers = [
            "HTTP/1.1 \(status) \(httpReason(status))",
            "Content-Type: application/json",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, Authorization",
            "Access-Control-Allow-Private-Network: true",
            "Content-Length: \(payload.count)",
            "Connection: close"
        ]
        if let cacheControl { headers.append("Cache-Control: \(cacheControl)") }
        let head = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        sendAndClose(id: id, data: head + payload)
    }

    private func sendEmpty(id: UUID, status: Int) {
        let headers = [
            "HTTP/1.1 \(status) \(httpReason(status))",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, Authorization",
            "Access-Control-Allow-Private-Network: true",
            "Content-Length: 0",
            "Connection: close",
            "",
            ""
        ].joined(separator: "\r\n")
        sendAndClose(id: id, data: Data(headers.utf8))
    }

    private func sendAndClose(id: UUID, data: Data) {
        guard let connection = connections[id] else { return }
        connection.send(content: data, completion: .contentProcessed { [weak self] _ in
            self?.dropConnection(id)
        })
    }

    private func httpReason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 413: return "Payload Too Large"
        case 431: return "Request Header Fields Too Large"
        default: return "Error"
        }
    }
}
