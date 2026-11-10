import Foundation

let bridgeService = "com.lighttorrent.safari.launcher"

@objc protocol LightTorrentNativeBridge {
    func ping(withReply reply: @escaping (String) -> Void)
    func perform(_ action: String, withReply reply: @escaping (Data) -> Void)
}

func failureResponse(_ message: String) -> Data {
    NSLog("Light Torrent Safari: %@", message)
    // This dictionary contains only JSON-compatible strings and a boolean.
    return try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
}
