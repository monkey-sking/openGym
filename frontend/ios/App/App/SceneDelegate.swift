import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    // The window and root view controller are created automatically from
    // Main.storyboard via the UISceneStoryboardFile key in Info.plist.
    // These callbacks just forward deep links / Universal Links to Capacitor,
    // since AppDelegate's equivalents are not called under the scene lifecycle.

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        for context in connectionOptions.urlContexts {
            open(context.url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { open(context.url) }
    }

    private func open(_ url: URL) {
        if PlanFileInbox.open(url) { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
    }
}

// The scene may receive a document before the WebView exists. Keep it until the page has
// restored the user's data and can show the existing import confirmation sheet.
enum PlanFileInbox {
    static let changed = Notification.Name("OpenGymPlanFilePending")
    static var pending: [[String: Any]] = [] // Accessed only on the main queue.
    private static let reader = DispatchQueue(label: "com.7fei.opengym.plan-file-reader")
    private static let limit = 10 * 1024 * 1024

    @discardableResult static func open(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        reader.async {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var item: [String: Any] = ["id": UUID().uuidString]
            let coordinator = NSFileCoordinator()
            var coordinationError: NSError?
            coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { readable in
                do {
                    let file = try FileHandle(forReadingFrom: readable)
                    defer { try? file.close() }
                    let data = try file.read(upToCount: limit + 1) ?? Data()
                    guard data.count <= limit, let text = String(data: data, encoding: .utf8) else {
                        item["error"] = true
                        return
                    }
                    item["text"] = text
                } catch { item["error"] = true }
            }
            if coordinationError != nil || item["text"] == nil { item["error"] = true }
            let result = item
            DispatchQueue.main.async {
                pending.append(result)
                NotificationCenter.default.post(name: changed, object: nil)
            }
        }
        return true
    }
}

@objc(PlanFileImportPlugin)
public class PlanFileImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PlanFileImportPlugin"
    public let jsName = "PlanFileImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
    ]
    private var observer: NSObjectProtocol?

    public override func load() {
        observer = NotificationCenter.default.addObserver(forName: PlanFileInbox.changed, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("pendingChanged", data: [:])
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    @objc func getPending(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(PlanFileInbox.pending.first ?? [:]) }
    }

    @objc func acknowledge(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("id") {
                PlanFileInbox.pending.removeAll { $0["id"] as? String == id }
            }
            call.resolve()
        }
    }
}
