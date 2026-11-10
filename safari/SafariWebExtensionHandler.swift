import SafariServices

final class NativeRequest {
    private let context: NSExtensionContext
    private let connection = NSXPCConnection(machServiceName: bridgeService)
    private let lock = NSLock()
    private var finished = false
    private var timeout: DispatchWorkItem?

    init(_ context: NSExtensionContext) {
        self.context = context
    }

    func start(_ action: String) {
        connection.remoteObjectInterface = NSXPCInterface(with: LightTorrentNativeBridge.self)
        connection.invalidationHandler = {
            self.finish(failureResponse("The Safari native bridge disconnected. Run npm run install:safari again."))
        }
        connection.interruptionHandler = {
            self.finish(failureResponse("The Safari native bridge was interrupted. Try again."))
        }
        let deadline = DispatchWorkItem {
            self.finish(failureResponse("The Safari native helper timed out. Try again."))
        }
        timeout = deadline
        DispatchQueue.global().asyncAfter(deadline: .now() + 340, execute: deadline)
        connection.resume()
        let remote = connection.remoteObjectProxyWithErrorHandler { error in
            self.finish(failureResponse("Could not contact the Safari native helper: \(error.localizedDescription). Run npm run install:safari again."))
        } as! LightTorrentNativeBridge
        remote.perform(action) { self.finish($0) }
    }

    private func finish(_ data: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        lock.unlock()
        timeout?.cancel()
        timeout = nil
        connection.invalidationHandler = nil
        connection.interruptionHandler = nil
        connection.invalidate()
        let response = NSExtensionItem()
        do {
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] is Bool else {
                throw NSError(domain: bridgeService, code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid native response"])
            }
            response.userInfo = [SFExtensionMessageKey: result]
        } catch {
            NSLog("Light Torrent Safari: %@", error.localizedDescription)
            response.userInfo = [SFExtensionMessageKey: ["ok": false, "error": error.localizedDescription]]
        }
        context.completeRequest(returningItems: [response])
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              message.count == 1, let action = message["action"] as? String,
              ["start-client", "change-folder"].contains(action) else {
            NSLog("Light Torrent Safari rejected an invalid native request.")
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: ["ok": false, "error": "Only start-client and change-folder requests are supported."]]
            context.completeRequest(returningItems: [response])
            return
        }
        NativeRequest(context).start(action)
    }
}
