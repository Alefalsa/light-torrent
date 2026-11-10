import Cocoa
import SafariServices

final class NativeBridge: NSObject, NSXPCListenerDelegate, LightTorrentNativeBridge {
    private let listener = NSXPCListener(machServiceName: bridgeService)
    private var lastActivity = Date()
    private var pending = 0
    private var idleTimer: Timer?

    func start() {
        listener.delegate = self
        listener.resume()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self, self.pending == 0, Date().timeIntervalSince(self.lastActivity) >= 120 else { return }
            NSApplication.shared.terminate(nil)
        }
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier == getuid() else { return false }
        connection.exportedInterface = NSXPCInterface(with: LightTorrentNativeBridge.self)
        connection.exportedObject = self
        connection.resume()
        return true
    }

    func ping(withReply reply: @escaping (String) -> Void) {
        DispatchQueue.main.async { self.lastActivity = Date() }
        reply("light-torrent-safari/1")
    }

    func perform(_ action: String, withReply reply: @escaping (Data) -> Void) {
        guard ["start-client", "change-folder"].contains(action) else {
            reply(failureResponse("Only the start-client and change-folder actions are supported."))
            return
        }
        DispatchQueue.main.async {
            self.pending += 1
            DispatchQueue.global(qos: .userInitiated).async {
                reply(self.runHost(action))
                DispatchQueue.main.async {
                    self.pending -= 1
                    self.lastActivity = Date()
                }
            }
        }
    }

    private func runHost(_ action: String) -> Data {
        do {
            guard let configURL = Bundle.main.url(forResource: "NativeHost", withExtension: "json"),
                  let config = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: String],
                  let node = config["node"], let root = config["root"] else {
                return failureResponse("Safari helper configuration is missing. Run npm run install:safari again.")
            }
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [URL(fileURLWithPath: root).appendingPathComponent("safari/host.js").path]
            process.currentDirectoryURL = URL(fileURLWithPath: root)
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.standardError
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 330, execute: timeout)
            defer {
                timeout.cancel()
                input.fileHandleForWriting.closeFile()
                output.fileHandleForReading.closeFile()
                if process.isRunning { process.terminate() }
            }
            func send(_ message: [String: Any]) throws {
                var line = try JSONSerialization.data(withJSONObject: message)
                line.append(10)
                try input.fileHandleForWriting.write(contentsOf: line)
            }
            try send(["action": action])
            var line = Data()
            while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
                if byte.first != 10 {
                    line.append(byte)
                    guard line.count <= 8192 else { return failureResponse("The Safari native response was too large.") }
                    continue
                }
                guard let event = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    return failureResponse("The Safari native helper returned an invalid event.")
                }
                line.removeAll(keepingCapacity: true)
                if event["type"] as? String == "choose-folder" {
                    let directory = DispatchQueue.main.sync { self.chooseDirectory() }
                    try send(["directory": directory.map { $0 as Any } ?? NSNull()])
                } else if event["type"] as? String == "result",
                          let response = event["response"] as? [String: Any], response["ok"] is Bool {
                    return try JSONSerialization.data(withJSONObject: response)
                } else {
                    return failureResponse("The Safari native helper returned an unknown event.")
                }
            }
            return failureResponse("The Safari native helper disconnected before returning a result. Check the Safari helper log.")
        } catch {
            return failureResponse("Could not run the native helper: \(error.localizedDescription). Run npm run install:safari again if Node.js or the project moved.")
        }
    }

    private func chooseDirectory() -> String? {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        defer { application.setActivationPolicy(.prohibited) }
        let panel = NSOpenPanel()
        panel.title = "Light Torrent"
        panel.message = "Choose where Light Torrent saves completed downloads"
        panel.prompt = "Choose"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        application.activate(ignoringOtherApps: true)
        let timeout = Timer(timeInterval: 300, repeats: false) { _ in panel.cancel(nil) }
        RunLoop.main.add(timeout, forMode: .modalPanel)
        defer { timeout.invalidate() }
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}

@main
enum SafariApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var bridge: NativeBridge?
    private var window: NSWindow?
    private var probe: NSXPCConnection?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--native-host") {
            NSApplication.shared.setActivationPolicy(.prohibited)
            bridge = NativeBridge()
            bridge?.start()
            return
        }
        if CommandLine.arguments.contains("--check-bridge") {
            NSApplication.shared.setActivationPolicy(.prohibited)
            checkBridge()
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 190),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Light Torrent Safari"
        let label = NSTextField(wrappingLabelWithString:
            "Enable Light Torrent in Safari Settings > Extensions, then allow access to the websites where you use magnet links.\n\nThe native helper starts automatically when needed. You can close this window.")
        label.frame = NSRect(x: 24, y: 70, width: 432, height: 96)
        window.contentView?.addSubview(label)
        let button = NSButton(title: "Open Safari Extension Settings", target: self, action: #selector(openSettings))
        button.frame = NSRect(x: 110, y: 22, width: 260, height: 32)
        window.contentView?.addSubview(button)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.window = window
    }

    @objc private func openSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: "com.lighttorrent.safari.Extension") { error in
            if let error {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Could not open Safari extension settings"
                    alert.informativeText = error.localizedDescription
                    alert.runModal()
                }
            } else {
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            }
        }
    }

    private func checkBridge() {
        let connection = NSXPCConnection(machServiceName: bridgeService)
        probe = connection
        connection.remoteObjectInterface = NSXPCInterface(with: LightTorrentNativeBridge.self)
        connection.resume()
        let remote = connection.remoteObjectProxyWithErrorHandler { error in
            fputs("Safari bridge failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        } as! LightTorrentNativeBridge
        remote.ping { version in
            guard version == "light-torrent-safari/1" else { exit(1) }
            remote.perform("invalid-action") { data in
                do {
                    let response = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    guard response?["ok"] as? Bool == false else { exit(1) }
                    print("Safari native bridge ready; invalid actions rejected.")
                    connection.invalidate()
                    exit(0)
                } catch {
                    fputs("Safari bridge returned invalid JSON: \(error)\n", stderr)
                    exit(1)
                }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
            fputs("Safari bridge check timed out.\n", stderr)
            exit(1)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return bridge == nil
    }
}
