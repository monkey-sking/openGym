import Foundation
import Capacitor
import Network
import Darwin

/**
 * Video Sync on iPhone, two roles in one plugin:
 *
 * 1. Discovery (original): browses the Wi-Fi LAN for an openGym video-sync relay via Bonjour
 *    (`_opengym._tcp.`), so the athlete does not have to type the computer's IP.
 *
 * 2. Phone as the relay (new): the phone runs its own tiny HTTP+SSE server on port 8787 and
 *    advertises the same Bonjour service. The Chrome extension finds it by the 4-character
 *    pairing code instead of the computer running a menu-bar relay. This makes "video on the
 *    computer, workout on the phone" work with no desktop software at all.
 *
 * The HTTP/SSE shapes are ported from tools/video-sync-extension/macos/main.swift (the reference
 * relay) and tools/video-sync-extension/local-server.mjs (the pairing contract), so the extension,
 * the settings screen (frontend/src/lib/video-sync.js) and this phone server all agree.
 *
 * Usage from JS:
 *   const res = await VideoSyncDiscovery.discover({ timeout: 5000 })
 *   // { found: true, name, host, port }  — the phone's own server is a fallback
 *   const srv = await VideoSyncDiscovery.startServer({ code: 'AB2C' })
 *   // { ok: true, found: true, host, port, ips, url, localUrl, code }
 *   const reg = await VideoSyncDiscovery.registerPairCode({ code: 'AB2C' })
 *   // { ok: true, code, host, port, url, localUrl }
 */
@objc(VideoSyncDiscoveryPlugin)
public class VideoSyncDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin, NetServiceBrowserDelegate, NetServiceDelegate {
    public let identifier = "VideoSyncDiscoveryPlugin"
    public let jsName = "VideoSyncDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPairCode", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Discovery (browse for a relay on the LAN)

    private var browser: NetServiceBrowser?
    private var resolvingService: NetService?
    private var pendingServices: [NetService] = []
    private var activeCall: CAPPluginCall?
    private var timeoutWorkItem: DispatchWorkItem?
    private var sawService = false
    private var lastResolveErrorCode: Int?

    // MARK: - Embedded relay (the phone as the LAN server)

    private let relay = PhoneRelayServer()

    public override func load() {
        // Start hosting once the bridge is up. Failures are silent: discovery still works against
        // a computer relay, and startServer() reports anything the user must act on.
        relay.start(preferredPort: 8787) { _ in }
    }

    // MARK: - Plugin methods

    @objc func startServer(_ call: CAPPluginCall) {
        let code = call.getString("code")
        relay.start(preferredPort: 8787) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let info):
                if let code = code { _ = self.relay.registerPairCode(code) }
                call.resolve(self.serverPayload(info: info, code: self.relay.pairCode))
            case .failure(let message):
                call.resolve([
                    "ok": false,
                    "found": false,
                    "reason": "server-failed",
                    "message": message
                ])
            }
        }
    }

    @objc func registerPairCode(_ call: CAPPluginCall) {
        guard let raw = call.getString("code"), let code = self.relay.registerPairCode(raw) else {
            call.resolve(["ok": false, "reason": "bad-code", "message": "A 4 character pairing code is required."])
            return
        }
        relay.start(preferredPort: 8787) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let info):
                var payload = self.serverPayload(info: info, code: code)
                payload["ok"] = true
                call.resolve(payload)
            case .failure(let message):
                call.resolve(["ok": false, "reason": "server-failed", "message": message])
            }
        }
    }

    @objc func discover(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let previous = self.activeCall {
                self.activeCall = nil
                self.cleanup()
                previous.resolve(self.failurePayload(
                    reason: "canceled",
                    message: "A newer local-network search replaced this one."
                ))
            } else {
                self.cleanup()
            }

            self.activeCall = call
            let timeoutSec = (call.getDouble("timeout") ?? 5000.0) / 1000.0
            self.sawService = false
            self.lastResolveErrorCode = nil
            self.pendingServices = []

            let b = NetServiceBrowser()
            b.delegate = self
            self.browser = b

            let item = DispatchWorkItem { [weak self] in
                guard let self = self, self.activeCall != nil else { return }
                // No computer relay answered in time. If this phone is hosting, that IS the relay:
                // return its own address so discovery never dead-ends on the device that serves it.
                if self.resolvingService == nil && !self.sawService {
                    if let info = self.relay.readyInfo() {
                        self.finishFoundOwnServer(info: info)
                        return
                    }
                }
                if self.resolvingService != nil || self.sawService {
                    self.finishFailure(
                        reason: "resolution-failed",
                        message: self.failureDetail(
                            prefix: "The relay was found, but its Wi-Fi address could not be resolved.",
                            code: self.lastResolveErrorCode
                        )
                    )
                } else {
                    self.finishFailure(
                        reason: "not-found",
                        message: "No openGym video-sync relay was found on this Wi-Fi network."
                    )
                }
            }
            self.timeoutWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + max(1.0, timeoutSec), execute: item)

            b.searchForServices(ofType: "_opengym._tcp.", inDomain: "local.")
        }
    }

    private func finishFoundOwnServer(info: ServerInfo) {
        guard let call = activeCall else {
            cleanup()
            return
        }
        activeCall = nil
        cleanup()
        let host = info.primaryIP ?? "127.0.0.1"
        call.resolve([
            "found": true,
            "name": "openGym (this iPhone)",
            "host": host,
            "port": Int(info.port),
            "url": "http://\(host):\(info.port)",
            "localUrl": "http://127.0.0.1:\(info.port)"
        ])
    }

    private func serverPayload(info: ServerInfo, code: String?) -> [String: Any] {
        let host = info.primaryIP ?? "127.0.0.1"
        return [
            "ok": true,
            "found": true,
            "host": host,
            "port": Int(info.port),
            "ips": info.ips,
            "url": "http://\(host):\(info.port)",
            "localUrl": "http://127.0.0.1:\(info.port)",
            "code": code ?? NSNull()
        ]
    }

    // MARK: - NetServiceBrowserDelegate

    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard activeCall != nil else { return }
        sawService = true
        let duplicate = pendingServices.contains {
            $0.name == service.name && $0.type == service.type && $0.domain == service.domain
        }
        if !duplicate {
            pendingServices.append(service)
        }
        resolveNext()
    }

    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
        let code = (errorDict["NSNetServicesErrorCode"] as? NSNumber)?.intValue
        if isPermissionError(code) {
            // Permission is blocked, but this phone can still be its own relay; fall back to it.
            if let info = relay.readyInfo() {
                finishFoundOwnServer(info: info)
                return
            }
            finishPermissionDenied(code: code)
        } else {
            finishFailure(
                reason: "search-failed",
                message: failureDetail(prefix: "The iPhone could not search the local network.", code: code)
            )
        }
    }

    // MARK: - NetServiceDelegate

    public func netServiceDidResolveAddress(_ sender: NetService) {
        let name = sender.name
        let port = sender.port
        var hostString: String? = nil

        if let addresses = sender.addresses {
            for data in addresses {
                data.withUnsafeBytes { raw in
                    guard let addr = raw.baseAddress?.assumingMemoryBound(to: sockaddr.self) else { return }
                    if addr.pointee.sa_family == UInt8(AF_INET) {
                        var ip = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                        if let sin = raw.baseAddress?.assumingMemoryBound(to: sockaddr_in.self) {
                            var addrStorage = sin.pointee.sin_addr
                            if inet_ntop(AF_INET, &addrStorage, &ip, socklen_t(INET_ADDRSTRLEN)) != nil {
                                hostString = String(cString: ip)
                            }
                        }
                    }
                }
                if hostString != nil { break }
            }
        }

        if hostString == nil, let rawHost = sender.hostName {
            hostString = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }

        guard let host = hostString, port > 0 else {
            resolvingService = nil
            resolveNext()
            return
        }

        finishFound(name: name, host: host, port: port)
    }

    public func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
        let code = (errorDict["NSNetServicesErrorCode"] as? NSNumber)?.intValue
        lastResolveErrorCode = code
        resolvingService = nil
        if isPermissionError(code) {
            finishPermissionDenied(code: code)
        } else {
            resolveNext()
        }
    }

    // MARK: - Helpers

    private func resolveNext() {
        guard activeCall != nil, resolvingService == nil, !pendingServices.isEmpty else { return }
        let service = pendingServices.removeFirst()
        resolvingService = service
        service.delegate = self
        service.resolve(withTimeout: 4.0)
    }

    private func finishFound(name: String, host: String, port: Int) {
        guard let call = activeCall else {
            cleanup()
            return
        }
        activeCall = nil
        cleanup()
        call.resolve([
            "found": true,
            "name": name,
            "host": host,
            "port": port
        ])
    }

    private func finishFailure(reason: String, message: String) {
        guard let call = activeCall else {
            cleanup()
            return
        }
        activeCall = nil
        cleanup()
        call.resolve(failurePayload(reason: reason, message: message))
    }

    private func finishPermissionDenied(code: Int?) {
        finishFailure(
            reason: "permission-denied",
            message: failureDetail(
                prefix: "Local Network access is off. Allow openGym in Settings > Privacy & Security > Local Network, then try again.",
                code: code
            )
        )
    }

    private func failurePayload(reason: String, message: String) -> [String: Any] {
        [
            "found": false,
            "reason": reason,
            "message": message
        ]
    }

    private func isPermissionError(_ code: Int?) -> Bool {
        code == -65570 || code == -65555
    }

    private func failureDetail(prefix: String, code: Int?) -> String {
        guard let code = code else { return prefix }
        return "\(prefix) (network error \(code))"
    }

    private func cleanup() {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        browser?.stop()
        browser?.delegate = nil
        browser = nil
        resolvingService?.stop()
        resolvingService?.delegate = nil
        resolvingService = nil
        for service in pendingServices {
            service.delegate = nil
            service.stop()
        }
        pendingServices = []
    }

    deinit {
        cleanup()
    }
}
