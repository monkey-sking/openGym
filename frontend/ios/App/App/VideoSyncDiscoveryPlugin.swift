import Foundation
import Capacitor

/**
 * Discovers the openGym video sync local relay server on the same Wi-Fi LAN
 * via Bonjour (mDNS: `_opengym._tcp.`).
 *
 * When the athlete opens the Video Sync sheet on iPhone, this searches the local
 * network so they don't have to look up and type their computer's IP address.
 *
 * Usage from JS:
 *   const { VideoSyncDiscovery } = await import('@capacitor/core').then(c => ({
 *     VideoSyncDiscovery: c.registerPlugin('VideoSyncDiscovery')
 *   }))
 *   const res = await VideoSyncDiscovery.discover({ timeout: 5000 })
 *   // res -> { found: true, name: "...", host: "192.168.1.5", port: 8787 }
 *   //    or  { found: false, reason: "permission-denied", message: "..." }
 */
@objc(VideoSyncDiscoveryPlugin)
public class VideoSyncDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin, NetServiceBrowserDelegate, NetServiceDelegate {
    public let identifier = "VideoSyncDiscoveryPlugin"
    public let jsName = "VideoSyncDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
    ]

    private var browser: NetServiceBrowser?
    private var resolvingService: NetService?
    private var pendingServices: [NetService] = []
    private var activeCall: CAPPluginCall?
    private var timeoutWorkItem: DispatchWorkItem?
    private var sawService = false
    private var lastResolveErrorCode: Int?

    @objc func discover(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // A new request supersedes the old one. Resolve the old promise instead of leaving
            // a JavaScript caller waiting forever.
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
            // One candidate can fail while a later Bonjour result is still usable. Try the next
            // service instead of turning the whole discovery into a red error.
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
        // DNS-SD PolicyDenied and NoAuth are the two codes iOS returns before Bonjour can run.
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
