import AppKit
import Darwin
import Foundation
import Network

private let helperBundleIdentifier = "ai.opengym.video-sync"
private let loginItemLabel = "ai.opengym.video-sync-relay"
private let defaultPort: UInt16 = 8787
private let phoneAppStaleMilliseconds = 6_000
private let bonjourServiceName = "openGym Video Sync"
private let bonjourServiceType = "_opengym._tcp."
private let automaticSetupCompleteKey = "didCompleteAutomaticSetup"

private typealias JSONObject = [String: Any]

private func nowMilliseconds() -> Int {
    Int((Date().timeIntervalSince1970 * 1_000).rounded())
}

private func jsonData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
}

private func jsonString(_ object: Any) -> String {
    String(decoding: jsonData(object), as: UTF8.self)
}

private func stringValue(_ value: Any?) -> String? {
    guard let string = value as? String else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func finiteDouble(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
}

private func lanIPv4Addresses() -> [String] {
    var pointer: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
    defer { freeifaddrs(pointer) }

    var addresses = Set<String>()
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let interface = cursor {
        defer { cursor = interface.pointee.ifa_next }
        guard let address = interface.pointee.ifa_addr,
              address.pointee.sa_family == UInt8(AF_INET) else { continue }
        let flags = Int32(interface.pointee.ifa_flags)
        guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }

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
            addresses.insert(String(cString: host))
        }
    }
    return addresses.sorted()
}

private final class NativeRelayServer: NSObject {
    private let queue = DispatchQueue(label: "ai.opengym.video-sync.relay")
    private let epoch = UUID().uuidString.lowercased()
    private var listener: NWListener?
    private var bonjourPublished = false
    private var heartbeat: DispatchSourceTimer?
    private lazy var state: JSONObject = [
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
        "at": nowMilliseconds()
    ]
    private var lastAppAt = 0
    private var generation = 0
    private var streamClients: [UUID: NWConnection] = [:]
    private var connections: [UUID: NWConnection] = [:]
    private var requestBuffers: [UUID: Data] = [:]
    private var onReady: ((UInt16) -> Void)?
    private var onFailure: ((String) -> Void)?

    private(set) var boundPort: UInt16?

    func start(
        port requestedPort: UInt16,
        onReady: @escaping (UInt16) -> Void,
        onFailure: @escaping (String) -> Void
    ) throws {
        stop()
        generation += 1
        let attempt = generation
        self.onReady = onReady
        self.onFailure = onFailure

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let nextListener: NWListener
        if requestedPort == 0 {
            nextListener = try NWListener(using: parameters)
        } else {
            guard let port = NWEndpoint.Port(rawValue: requestedPort) else {
                throw NSError(
                    domain: helperBundleIdentifier,
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid relay port \(requestedPort)."]
                )
            }
            nextListener = try NWListener(using: parameters, on: port)
        }
        listener = nextListener
        nextListener.service = NWListener.Service(
            name: bonjourServiceName,
            type: bonjourServiceType,
            domain: "local."
        )
        nextListener.serviceRegistrationUpdateHandler = { [weak self] change in
            guard let self, self.generation == attempt else { return }
            switch change {
            case .add:
                self.bonjourPublished = true
            case .remove:
                self.bonjourPublished = false
            @unknown default:
                break
            }
        }

        nextListener.stateUpdateHandler = { [weak self] newState in
            guard let self, self.generation == attempt else { return }
            switch newState {
            case .ready:
                guard let port = nextListener.port?.rawValue else {
                    self.fail("The relay started without a usable port.", attempt: attempt)
                    return
                }
                self.boundPort = port
                self.bonjourPublished = true
                DispatchQueue.main.async { self.onReady?(port) }
            case .waiting:
                self.bonjourPublished = false
            case .failed(let error):
                self.fail(error.localizedDescription, attempt: attempt)
            case .cancelled:
                self.bonjourPublished = false
                if self.boundPort != nil {
                    self.boundPort = nil
                }
            default:
                break
            }
        }
        nextListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        nextListener.start(queue: queue)
    }

    func stop() {
        generation += 1
        heartbeat?.cancel()
        heartbeat = nil
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.serviceRegistrationUpdateHandler = nil
        listener?.service = nil
        listener?.cancel()
        listener = nil
        boundPort = nil
        bonjourPublished = false
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        requestBuffers.removeAll()
        streamClients.removeAll()
    }

    private func fail(_ message: String, attempt: Int) {
        guard generation == attempt else { return }
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.serviceRegistrationUpdateHandler = nil
        listener?.service = nil
        listener?.cancel()
        listener = nil
        boundPort = nil
        bonjourPublished = false
        heartbeat?.cancel()
        heartbeat = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        requestBuffers.removeAll()
        streamClients.removeAll()
        DispatchQueue.main.async { self.onFailure?(message) }
    }

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

    // Returns true when the request is complete and no further receive is needed.
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

    private func handle(
        method: String,
        target: String,
        headers: [String: String],
        body: Data,
        id: UUID
    ) {
        let origin = headers["host"].flatMap { URL(string: "http://\($0)") } ?? URL(string: "http://localhost")!
        let components = URLComponents(string: target) ?? URLComponents(url: origin, resolvingAgainstBaseURL: false)
        var path = components?.path ?? "/"
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/" }

        if method == "OPTIONS" {
            sendEmpty(id: id, status: 204)
            return
        }
        if method == "GET", path == "/health" {
            var payload: JSONObject = [
                "ok": true,
                "version": 1,
                "relayKind": "mac-menu-bar",
                "ips": lanIPv4Addresses(),
                "bonjourPublished": bonjourPublished,
                "bonjourService": [
                    "name": bonjourServiceName,
                    "type": bonjourServiceType,
                    "domain": "local."
                ]
            ]
            for (key, value) in connectionInfo() { payload[key] = value }
            sendJSON(id: id, status: 200, object: payload, cacheControl: "no-store")
            return
        }
        if method == "GET", path == "/state" || path == "/api/video-sync/state" {
            markAppSeen()
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
            guard let object = parsed as? JSONObject else {
                sendJSON(id: id, status: 400, object: ["ok": false, "error": "body must be a JSON object"])
                return
            }
            sendJSON(id: id, status: 200, object: applyCommand(object))
            return
        }
        sendJSON(id: id, status: 404, object: ["error": "not found"])
    }

    private func markAppSeen() {
        lastAppAt = nowMilliseconds()
    }

    private func connectionInfo() -> JSONObject {
        let extensionConnected = !streamClients.isEmpty
        let phoneAppConnected = lastAppAt > 0 && nowMilliseconds() - lastAppAt <= phoneAppStaleMilliseconds
        let sessionID = state["sessionId"] as? String
        return [
            "clients": streamClients.count,
            "extensionConnected": extensionConnected,
            "phoneAppConnected": phoneAppConnected,
            "phoneConnected": phoneAppConnected && extensionConnected && sessionID != nil,
            "lastAppAt": lastAppAt > 0 ? lastAppAt : NSNull(),
            "sessionId": sessionID ?? NSNull(),
            "action": state["action"] ?? NSNull(),
            "stateAt": state["at"] ?? nowMilliseconds()
        ]
    }

    private func applyCommand(_ body: JSONObject) -> JSONObject {
        let action = stringValue(body["action"])
        let source = stringValue(body["source"]) ?? "unknown"
        if source == "app" { markAppSeen() }

        let previousSeq = (state["seq"] as? Int) ?? 0
        let previousSessionID = state["sessionId"] as? String
        let previousVideoURL = state["videoUrl"] as? String
        let suppliedURL = stringValue(body["videoUrl"])
        let namedURL = suppliedURL.flatMap { value -> String? in
            let lower = value.lowercased()
            return lower.hasPrefix("http://") || lower.hasPrefix("https://") ? value : nil
        }
        let nextSessionID: String?
        if action == "end" {
            nextSessionID = nil
        } else {
            nextSessionID = stringValue(body["sessionId"]) ?? previousSessionID
        }
        let nextVideoURL: String?
        if action == "end" {
            nextVideoURL = nil
        } else if source == "video" {
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

        let nextState: JSONObject = [
            "epoch": epoch,
            "seq": previousSeq + 1,
            "action": action ?? NSNull(),
            "source": source,
            "sessionId": nextSessionID ?? NSNull(),
            "videoUrl": nextVideoURL ?? NSNull(),
            "pos": finiteDouble(body["pos"]) ?? NSNull(),
            "offset": finiteDouble(body["offset"]) ?? (state["offset"] as? Double) ?? 0,
            "force": body["force"] as? Bool ?? false,
            "play": nextPlay,
            "online": !streamClients.isEmpty,
            "at": nowMilliseconds()
        ]
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

    private func broadcast(_ snapshot: JSONObject) {
        for connection in streamClients.values {
            sendSSE(connection, object: snapshot)
        }
    }

    private func sendSSE(_ connection: NWConnection, object: JSONObject) {
        let payload = "data: \(jsonString(object))\n\n"
        connection.send(content: Data(payload.utf8), completion: .contentProcessed { _ in })
    }

    private func sendJSON(
        id: UUID,
        status: Int,
        object: JSONObject,
        cacheControl: String? = nil
    ) {
        let payload = jsonData(object)
        var headers = [
            "HTTP/1.1 \(status) \(httpReason(status))",
            "Content-Type: application/json",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, Authorization",
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

private enum HelperInstaller {
    static func launchAgentURL(home: URL) -> URL {
        home
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("LaunchAgents", isDirectory: true)
            .appendingPathComponent("\(loginItemLabel).plist")
    }

    static func appURL(home: URL) -> URL {
        home
            .appendingPathComponent("Applications", isDirectory: true)
            .appendingPathComponent("openGym Video Sync.app", isDirectory: true)
    }

    static func programURL(app: URL) -> URL {
        app
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent("openGymVideoSync")
    }

    static func installLoginItem(home: URL, app: URL) throws -> URL {
        let destination = launchAgentURL(home: home)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let executable = programURL(app: app).path
        let escaped = xmlEscape(executable)
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(loginItemLabel)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(escaped)</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <dict>
            <key>SuccessfulExit</key>
            <false/>
          </dict>
          <key>ThrottleInterval</key>
          <integer>10</integer>
          <key>ProcessType</key>
          <string>Interactive</string>
          <key>LimitLoadToSessionType</key>
          <string>Aqua</string>
        </dict>
        </plist>
        """
        try Data(plist.utf8).write(to: destination, options: .atomic)
        return destination
    }

    static func uninstallLoginItem(home: URL) throws {
        let destination = launchAgentURL(home: home)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
    }

    static func uninstallHelper(home: URL) throws -> [String: Any] {
        try uninstallLoginItem(home: home)
        let destination = appURL(home: home)
        var appRemoved = false
        if FileManager.default.fileExists(atPath: destination.path) {
            let installedID = Bundle(url: destination)?.bundleIdentifier
            guard installedID == helperBundleIdentifier else {
                return [
                    "loginItemRemoved": true,
                    "appRemoved": false,
                    "appLeftUntouched": destination.path
                ]
            }
            try FileManager.default.removeItem(at: destination)
            appRemoved = true
        }
        return [
            "loginItemRemoved": true,
            "appRemoved": appRemoved,
            "appLeftUntouched": NSNull()
        ]
    }

    static func installApplicationCopy(from source: URL, home: URL) throws -> URL {
        let destination = appURL(home: home)
        if source.standardizedFileURL == destination.standardizedFileURL {
            return destination
        }
        let manager = FileManager.default
        try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if manager.fileExists(atPath: destination.path) {
            let existingID = Bundle(url: destination)?.bundleIdentifier
            guard existingID == helperBundleIdentifier else {
                throw NSError(
                    domain: helperBundleIdentifier,
                    code: 2,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "\(destination.path) already exists and is not the openGym helper. It was left untouched."
                    ]
                )
            }
            try manager.removeItem(at: destination)
        }
        try manager.copyItem(at: source, to: destination)
        return destination
    }

    static func installUserSetup(from source: URL, home: URL) throws -> (app: URL, plist: URL) {
        let app = try installApplicationCopy(from: source, home: home)
        let plist = try installLoginItem(home: home, app: app)
        return (app, plist)
    }

    private static func xmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var relay = NativeRelayServer()
    private var healthTimer: Timer?
    private var relayRetryTimer: Timer?
    private var statusTitle = "Starting video sync…"
    private var detailTitle = "Local Wi-Fi only"
    private var healthy = false
    private var retryDelay: TimeInterval = 2

    func applicationDidFinishLaunching(_ notification: Notification) {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        let existing = NSRunningApplication
            .runningApplications(withBundleIdentifier: helperBundleIdentifier)
            .first { $0.processIdentifier != currentPID }
        if let existing {
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)
        installStatusItem()
        startRelay()
        startHealthPolling()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.completeAutomaticSetupIfNeeded()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        relayRetryTimer?.invalidate()
        relay.stop()
    }

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setStatusImage("tv.and.iphone")
        statusItem.button?.toolTip = "openGym Video Sync"
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()

        let heading = NSMenuItem(title: "openGym Video Sync", action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)

        let status = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        let detail = NSMenuItem(title: detailTitle, action: nil, keyEquivalent: "")
        detail.isEnabled = false
        menu.addItem(detail)
        menu.addItem(.separator())

        let loginInstalled = loginItemIsInstalled()
        let login = NSMenuItem(
            title: "Start When I Sign In",
            action: #selector(toggleLoginItem(_:)),
            keyEquivalent: ""
        )
        login.target = self
        login.state = loginInstalled ? .on : .off
        menu.addItem(login)

        let restart = NSMenuItem(
            title: "Restart Relay",
            action: #selector(restartRelay(_:)),
            keyEquivalent: "r"
        )
        restart.target = self
        menu.addItem(restart)

        let reveal = NSMenuItem(
            title: "Reveal Helper in Finder",
            action: #selector(revealHelper(_:)),
            keyEquivalent: ""
        )
        reveal.target = self
        menu.addItem(reveal)

        let help = NSMenuItem(
            title: "Connection Help…",
            action: #selector(showConnectionHelp(_:)),
            keyEquivalent: ""
        )
        help.target = self
        menu.addItem(help)

        let uninstall = NSMenuItem(
            title: "Uninstall openGym Video Sync…",
            action: #selector(uninstallHelper(_:)),
            keyEquivalent: ""
        )
        uninstall.target = self
        menu.addItem(uninstall)
        menu.addItem(.separator())

        let quit = NSMenuItem(
            title: "Quit openGym Video Sync",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quit)
        statusItem.menu = menu

        setStatusImage(healthy ? "tv.and.iphone" : "exclamationmark.triangle.fill")
        statusItem.button?.toolTip = "openGym Video Sync: \(statusTitle)"
    }

    private func setStatusImage(_ symbolName: String) {
        let image = NSImage(
            systemSymbolName: symbolName,
            accessibilityDescription: "openGym Video Sync"
        ) ?? NSImage(named: NSImage.networkName)
        image?.isTemplate = true
        statusItem.button?.image = image
    }

    private func startRelay() {
        relayRetryTimer?.invalidate()
        relayRetryTimer = nil
        statusTitle = "Starting video sync…"
        detailTitle = "No Terminal or Node.js required"
        rebuildMenu()
        if existingRelayIsRunning() {
            statusTitle = "An existing relay is already running"
            detailTitle = "Using the compatible relay on port \(defaultPort)"
            healthy = true
            rebuildMenu()
            return
        }
        do {
            try relay.start(
                port: defaultPort,
                onReady: { [weak self] port in
                    guard let self else { return }
                    self.retryDelay = 2
                    self.statusTitle = "Running on port \(port)"
                    let addresses = lanIPv4Addresses()
                    self.detailTitle = addresses.isEmpty
                        ? "Wi-Fi address is not available"
                        : "Wi-Fi: \(addresses.joined(separator: ", ")):\(port)"
                    self.healthy = true
                    self.rebuildMenu()
                },
                onFailure: { [weak self] message in
                    self?.relayFailed(message)
                }
            )
        } catch {
            relayFailed(error.localizedDescription)
        }
    }

    private func relayFailed(_ message: String) {
        healthy = false
        statusTitle = "Video sync needs attention"
        detailTitle = message
        rebuildMenu()
        relayRetryTimer?.invalidate()
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, 30)
        relayRetryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.startRelay()
        }
    }

    private func startHealthPolling() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.pollHealth()
        }
        pollHealth()
    }

    private func pollHealth() {
        guard let url = URL(string: "http://127.0.0.1:\(defaultPort)/health") else { return }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            if error != nil {
                if self.healthy {
                    DispatchQueue.main.async {
                        self.healthy = false
                        self.statusTitle = "Relay is restarting…"
                        self.rebuildMenu()
                    }
                }
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data,
                  let payload = try? JSONSerialization.jsonObject(with: data) as? JSONObject else {
                return
            }
            let extensionConnected = payload["extensionConnected"] as? Bool ?? false
            let phoneConnected = payload["phoneConnected"] as? Bool ?? false
            let bonjourPublished = payload["bonjourPublished"] as? Bool ?? false
            DispatchQueue.main.async {
                self.healthy = true
                if phoneConnected {
                    self.statusTitle = "Connected to Chrome and the phone workout"
                    self.detailTitle = "Pause and resume are synchronized"
                } else if extensionConnected {
                    self.statusTitle = "Chrome connected"
                    self.detailTitle = bonjourPublished
                        ? "Waiting for a phone workout"
                        : "Waiting for a workout; iPhone auto-discovery is unavailable"
                } else {
                    self.statusTitle = "Relay running on port \(defaultPort)"
                    self.detailTitle = bonjourPublished
                        ? "Chrome extension is not connected"
                        : "Chrome is disconnected; iPhone auto-discovery is unavailable"
                }
                self.rebuildMenu()
            }
        }.resume()
    }

    private func existingRelayIsRunning() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(defaultPort)/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.8
        let semaphore = DispatchSemaphore(value: 0)
        var compatible = false
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? JSONObject else { return }
            compatible = object["ok"] as? Bool == true
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1)
        return compatible
    }

    private func loginItemIsInstalled() -> Bool {
        FileManager.default.fileExists(
            atPath: HelperInstaller.launchAgentURL(home: FileManager.default.homeDirectoryForCurrentUser).path
        )
    }

    private func completeAutomaticSetupIfNeeded() {
        let defaults = UserDefaults.standard
        if loginItemIsInstalled() {
            defaults.set(true, forKey: automaticSetupCompleteKey)
            return
        }
        guard !defaults.bool(forKey: automaticSetupCompleteKey) else { return }

        do {
            let home = FileManager.default.homeDirectoryForCurrentUser
            _ = try HelperInstaller.installUserSetup(from: Bundle.main.bundleURL, home: home)
            defaults.set(true, forKey: automaticSetupCompleteKey)
            rebuildMenu()
        } catch {
            showAlert(
                title: "Could not finish Mac helper setup",
                message: """
                \(error.localizedDescription)

                Open openGym Video Sync again to retry. No Terminal or administrator password is needed.
                """
            )
        }
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        if loginItemIsInstalled() {
            disableLoginItem()
        } else {
            enableLoginItem()
        }
    }

    private func enableLoginItem() {
        do {
            let home = FileManager.default.homeDirectoryForCurrentUser
            _ = try HelperInstaller.installUserSetup(from: Bundle.main.bundleURL, home: home)
            UserDefaults.standard.set(true, forKey: automaticSetupCompleteKey)
            rebuildMenu()
            showAlert(
                title: "Start When I Sign In is on",
                message: "openGym Video Sync is installed for this user and will appear in the menu bar after you sign in."
            )
        } catch {
            showAlert(title: "Could not enable sign-in startup", message: error.localizedDescription)
        }
    }

    private func disableLoginItem() {
        do {
            try HelperInstaller.uninstallLoginItem(home: FileManager.default.homeDirectoryForCurrentUser)
            rebuildMenu()
            showAlert(
                title: "Sign-in startup is off",
                message: "The helper stays open until you quit it. You can turn on “Start When I Sign In” again from its menu."
            )
        } catch {
            showAlert(title: "Could not disable sign-in startup", message: error.localizedDescription)
        }
    }

    @objc private func showConnectionHelp(_ sender: NSMenuItem) {
        showAlert(
            title: "Video sync connection help",
            message: """
            This helper is running from the menu bar. Nothing needs to be started in Terminal.

            1. In Chrome, open chrome://extensions, make sure openGym Video Sync is enabled, then open its popup and click Reconnect.
            2. Keep the Mac and iPhone on the same Wi-Fi network.
            3. On iPhone, allow openGym under Settings > Privacy & Security > Local Network.
            4. In the openGym app, open Workout > More > Video sync and confirm Chrome and the phone workout both show as connected.

            If the relay is stopped or not responding, use Restart Relay above.
            """
        )
    }

    @objc private func uninstallHelper(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Uninstall openGym Video Sync?"
        alert.informativeText = """
        This turns off automatic startup and removes the helper from your Applications folder.
        Chrome, your workout data, and the phone app are not changed.
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        do {
            _ = try HelperInstaller.uninstallHelper(
                home: FileManager.default.homeDirectoryForCurrentUser
            )
            UserDefaults.standard.removeObject(forKey: automaticSetupCompleteKey)
            NSApp.terminate(nil)
        } catch {
            showAlert(title: "Could not uninstall the helper", message: error.localizedDescription)
        }
    }

    private func showAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func restartRelay(_ sender: NSMenuItem) {
        relay.stop()
        startRelay()
    }

    @objc private func revealHelper(_ sender: NSMenuItem) {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
}

private struct RelayTestOptions {
    var port: UInt16 = 0
    var retryMilliseconds = 500
    var singleAttempt = false
}

private func runRelayTest(_ options: RelayTestOptions) -> Never {
    let relay = NativeRelayServer()
    var stopped = false

    func stopAndExit() -> Never {
        if !stopped {
            stopped = true
            relay.stop()
        }
        exit(0)
    }

    func attempt() {
        do {
            try relay.start(
                port: options.port,
                onReady: { port in
                    print("READY \(port)")
                    fflush(stdout)
                },
                onFailure: { message in
                    if options.singleAttempt {
                        FileHandle.standardError.write(Data("ERROR \(message)\n".utf8))
                        exit(2)
                    }
                    print("RETRY \(message)")
                    fflush(stdout)
                    DispatchQueue.main.asyncAfter(
                        deadline: .now() + .milliseconds(options.retryMilliseconds)
                    ) {
                        attempt()
                    }
                }
            )
        } catch {
            if options.singleAttempt {
                FileHandle.standardError.write(Data("ERROR \(error.localizedDescription)\n".utf8))
                exit(2)
            }
            print("RETRY \(error.localizedDescription)")
            fflush(stdout)
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(options.retryMilliseconds)
            ) {
                attempt()
            }
        }
    }

    let signals = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler { stopAndExit() }
        source.resume()
        signal(signalNumber, SIG_IGN)
        return source
    }
    _ = signals
    attempt()
    RunLoop.main.run()
    stopAndExit()
}

private func runInstallTest(home: URL, app: URL) throws -> Never {
    let setup = try HelperInstaller.installUserSetup(from: app, home: home)
    print(jsonString([
        "ok": true,
        "plist": setup.plist.path,
        "installedApp": setup.app.path,
        "program": HelperInstaller.programURL(app: setup.app).path
    ]))
    exit(0)
}

private func runUninstallTest(home: URL) throws -> Never {
    try HelperInstaller.uninstallLoginItem(home: home)
    print(jsonString(["ok": true]))
    exit(0)
}

private func runUninstallHelperTest(home: URL) throws -> Never {
    let result = try HelperInstaller.uninstallHelper(home: home)
    var payload = result
    payload["ok"] = true
    print(jsonString(payload))
    exit(0)
}

private func optionValue(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

@main
private struct OpenGymVideoSyncMain {
    static func main() {
        let arguments = CommandLine.arguments
        if arguments.contains("--relay-test") {
            let parsedPort = optionValue("--port", in: arguments).flatMap(UInt16.init) ?? 0
            let retry = optionValue("--retry-ms", in: arguments).flatMap(Int.init) ?? 500
            runRelayTest(RelayTestOptions(
                port: parsedPort,
                retryMilliseconds: max(50, retry),
                singleAttempt: arguments.contains("--single-attempt")
            ))
        }
        if arguments.contains("--install-test") {
            guard let homePath = optionValue("--home", in: arguments),
                  let appPath = optionValue("--app-path", in: arguments) else {
                FileHandle.standardError.write(Data("ERROR --install-test needs --home and --app-path\n".utf8))
                exit(2)
            }
            do {
                try runInstallTest(
                    home: URL(fileURLWithPath: homePath, isDirectory: true),
                    app: URL(fileURLWithPath: appPath, isDirectory: true)
                )
            } catch {
                FileHandle.standardError.write(Data("ERROR \(error.localizedDescription)\n".utf8))
                exit(2)
            }
        }
        if arguments.contains("--uninstall-test") {
            guard let homePath = optionValue("--home", in: arguments) else {
                FileHandle.standardError.write(Data("ERROR --uninstall-test needs --home\n".utf8))
                exit(2)
            }
            do {
                try runUninstallTest(home: URL(fileURLWithPath: homePath, isDirectory: true))
            } catch {
                FileHandle.standardError.write(Data("ERROR \(error.localizedDescription)\n".utf8))
                exit(2)
            }
        }
        if arguments.contains("--uninstall-helper-test") {
            guard let homePath = optionValue("--home", in: arguments) else {
                FileHandle.standardError.write(
                    Data("ERROR --uninstall-helper-test needs --home\n".utf8)
                )
                exit(2)
            }
            do {
                try runUninstallHelperTest(
                    home: URL(fileURLWithPath: homePath, isDirectory: true)
                )
            } catch {
                FileHandle.standardError.write(Data("ERROR \(error.localizedDescription)\n".utf8))
                exit(2)
            }
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
