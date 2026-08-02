import UIKit
import Capacitor
import Darwin
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

@objc(ViewController)
class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OliveDiscoveryPlugin())
        bridge?.registerPluginInstance(OlivePlaybackPlugin())
    }
}

@objc(OlivePlaybackPlugin)
public class OlivePlaybackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OlivePlaybackPlugin"
    public let jsName = "OlivePlayback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
    ]

    private var host = ""
    private var port = 80
    private var state: MPNowPlayingPlaybackState = .stopped
    private var position = 0.0
    private var duration = 0.0
    private var artworkToken = UUID()
    private var artworkURL = ""
    private var cachedArtwork: MPMediaItemArtwork?
    private var commandTargets: [(MPRemoteCommand, Any)] = []
    private var pendingCommands = Set<String>()

    public override func load() {
        super.load()
        DispatchQueue.main.async { [weak self] in self?.configureCommands() }
    }

    @objc public func update(_ call: CAPPluginCall) {
        guard let target = call.getObject("target"),
              let incomingHost = target["host"] as? String,
              Self.isPrivateHost(incomingHost) else {
            call.reject("A private Olive address is required")
            return
        }
        let incomingPort = target["port"] as? Int ?? 80
        guard (1...65535).contains(incomingPort) else {
            call.reject("A valid Olive port is required")
            return
        }

        host = incomingHost
        port = incomingPort
        position = max(0, call.getDouble("positionSeconds") ?? 0)
        duration = max(0, call.getDouble("durationSeconds") ?? 0)
        let incomingState = call.getString("state") ?? "unknown"
        state = incomingState == "playing" ? .playing : incomingState == "paused" ? .paused : .stopped
        let sampledAt = call.getDouble("sampledAt") ?? Date().timeIntervalSince1970 * 1_000
        if state == .playing {
            position += max(0, Date().timeIntervalSince1970 - sampledAt / 1_000)
            if duration > 0 { position = min(duration, position) }
        }

        let incomingArtworkURL = call.getString("artworkUrl") ?? ""
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: call.getString("title") ?? "Playing on Olive",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyExternalContentIdentifier: call.getString("itemId") ?? "",
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let artist = call.getString("artist"), !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
        if let album = call.getString("album"), !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let artworkChanged = self.artworkURL != incomingArtworkURL
            if artworkChanged {
                self.artworkURL = incomingArtworkURL
                self.cachedArtwork = nil
                self.artworkToken = UUID()
            }
            if let artwork = self.cachedArtwork { info[MPMediaItemPropertyArtwork] = artwork }
            UIApplication.shared.beginReceivingRemoteControlEvents()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            MPNowPlayingInfoCenter.default().playbackState = self.state
            self.updateCommandAvailability()
            if artworkChanged && !incomingArtworkURL.isEmpty {
                self.loadArtwork(incomingArtworkURL, token: self.artworkToken)
            }
            call.resolve()
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        host = ""
        state = .stopped
        position = 0
        duration = 0
        artworkToken = UUID()
        DispatchQueue.main.async {
            self.pendingCommands.removeAll()
            self.artworkURL = ""
            self.cachedArtwork = nil
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            UIApplication.shared.endReceivingRemoteControlEvents()
            call.resolve()
        }
    }

    @objc public func acknowledge(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A command id is required")
            return
        }
        DispatchQueue.main.async {
            self.pendingCommands.remove(id)
            call.resolve()
        }
    }

    private func configureCommands() {
        guard commandTargets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()
        add(center.playCommand) { [weak self] _ in self?.dispatch("toggle") ?? .commandFailed }
        add(center.pauseCommand) { [weak self] _ in self?.dispatch("toggle") ?? .commandFailed }
        add(center.togglePlayPauseCommand) { [weak self] _ in self?.dispatch("toggle") ?? .commandFailed }
        add(center.previousTrackCommand) { [weak self] _ in self?.dispatch("previous") ?? .commandFailed }
        add(center.nextTrackCommand) { [weak self] _ in self?.dispatch("next") ?? .commandFailed }
        add(center.stopCommand) { [weak self] _ in self?.dispatch("stop") ?? .commandFailed }
        // The O4 advertises Seek but rejects both REL_TIME and ABS_TIME, while
        // its legacy seek endpoint returns success without moving playback.
        // Keep elapsed time visible in Control Center, but never advertise or
        // execute an unverified seek command.
        center.changePlaybackPositionCommand.isEnabled = false
        updateCommandAvailability()
    }

    private func add(_ command: MPRemoteCommand, handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
        let target = command.addTarget(handler: handler)
        commandTargets.append((command, target))
    }

    private func updateCommandAvailability() {
        let configured = !host.isEmpty
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = configured
        center.pauseCommand.isEnabled = configured
        center.togglePlayPauseCommand.isEnabled = configured
        center.previousTrackCommand.isEnabled = configured
        center.nextTrackCommand.isEnabled = configured
        center.stopCommand.isEnabled = configured
        center.changePlaybackPositionCommand.isEnabled = false
    }

    private func dispatch(_ action: String, position: Double? = nil) -> MPRemoteCommandHandlerStatus {
        guard !host.isEmpty else { return .noSuchContent }
        guard action != "seek" else { return .commandFailed }
        let id = UUID().uuidString
        pendingCommands.insert(id)
        var payload: [String: Any] = ["id": id, "action": action]
        if let position { payload["positionSeconds"] = position }
        notifyListeners("command", data: payload)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, self.pendingCommands.remove(id) != nil else { return }
            self.performFallback(action: action, position: position)
        }
        return .success
    }

    private func performFallback(action: String, position incomingPosition: Double?) {
        let nativeAction = action == "toggle" ? "pause" : action
        if action == "toggle" {
            state = state == .playing ? .paused : .playing
        } else if action == "stop" {
            state = .stopped
            position = 0
        } else {
            position = 0
        }
        updatePublishedState()
        perform(action: nativeAction)
    }

    private func updatePublishedState() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = self.position
            info[MPNowPlayingInfoPropertyPlaybackRate] = self.state == .playing ? 1.0 : 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            MPNowPlayingInfoCenter.default().playbackState = self.state
        }
    }

    private func perform(action: String, position: Double? = nil) {
        let currentHost = host
        let ports = [port, 80, 8163].reduce(into: [Int]()) { values, candidate in
            if !values.contains(candidate) { values.append(candidate) }
        }
        tryRequest(action: action, position: position, host: currentHost, ports: ports, index: 0)
    }

    private func tryRequest(action: String, position: Double?, host: String, ports: [Int], index: Int) {
        guard index < ports.count, let url = Self.commandURL(action: action, position: position, host: host, port: ports[index]) else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<400).contains(status) {
                self?.tryRequest(action: action, position: position, host: host, ports: ports, index: index + 1)
            }
        }.resume()
    }

    private static func commandURL(action: String, position: Double?, host: String, port: Int) -> URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        components.path = "/includes/ajax/a_executeOperation.php"
        switch action {
        case "pause":
            components.queryItems = [
                URLQueryItem(name: "action", value: "controlPlayer"),
                URLQueryItem(name: "root", value: "null"),
                URLQueryItem(name: "upnpid", value: "null"),
                URLQueryItem(name: "sortCrit", value: "+upnp:originalTrackNumber"),
                URLQueryItem(name: "index", value: "0"),
            ]
        case "stop":
            components.queryItems = [URLQueryItem(name: "action", value: "controlPlayer"), URLQueryItem(name: "id", value: "stop")]
        case "previous": components.queryItems = [URLQueryItem(name: "action", value: "left_skip")]
        case "next": components.queryItems = [URLQueryItem(name: "action", value: "right_skip")]
        default: return nil
        }
        return components.url
    }

    private func loadArtwork(_ value: String, token: UUID) {
        guard let url = URL(string: value), url.scheme == "http", Self.isPrivateHost(url.host ?? "") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            guard let self, self.artworkToken == token,
                  let response = response as? HTTPURLResponse,
                  response.statusCode == 200,
                  let data, data.count <= 8 * 1024 * 1024,
                  let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                guard self.artworkToken == token else { return }
                self.cachedArtwork = artwork
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }.resume()
    }

    private static func isPrivateHost(_ value: String) -> Bool {
        if value.lowercased().hasSuffix(".local") { return true }
        let parts = value.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || parts[0] == 127 || (parts[0] == 169 && parts[1] == 254) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
    }
}

@objc(OliveDiscoveryPlugin)
public class OliveDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OliveDiscoveryPlugin"
    public let jsName = "OliveDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanSubnet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "networkStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNetworkSettings", returnType: CAPPluginReturnPromise),
    ]
    private let worker = DispatchQueue(label: "com.djfracking.oliveremotelab.discovery", qos: .userInitiated)
    private static let allowedPorts = [80, 8163]

    @objc func networkStatus(_ call: CAPPluginCall) {
        let interfaces = Self.activeInterfaceNames()
        call.resolve([
            "localAddress": Self.activePrivateIPv4() ?? "",
            "wifi": interfaces.contains("en0"),
            "vpnActive": interfaces.contains { $0.hasPrefix("utun") || $0.hasPrefix("ppp") || $0.hasPrefix("ipsec") },
            "settingsLabel": "Open App Settings",
        ])
    }

    @objc func openNetworkSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString), UIApplication.shared.canOpenURL(url) else {
                call.reject("Could not open app settings")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened {
                    call.resolve()
                } else {
                    call.reject("Could not open app settings")
                }
            }
        }
    }

    @objc func discover(_ call: CAPPluginCall) {
        let timeoutMs = Self.clamp(call.getInt("timeoutMs") ?? 1800, minimum: 500, maximum: 4000)
        worker.async {
            do {
                call.resolve(["localAddress": Self.activePrivateIPv4() ?? "", "responses": try Self.ssdpSearch(timeoutMs: timeoutMs)])
            } catch {
                call.reject("Local SSDP discovery failed", nil, error)
            }
        }
    }

    @objc func scanSubnet(_ call: CAPPluginCall) {
        let timeoutMs = Self.clamp(call.getInt("timeoutMs") ?? 250, minimum: 100, maximum: 600)
        let concurrency = Self.clamp(call.getInt("concurrency") ?? 16, minimum: 4, maximum: 18)
        worker.async {
            guard let localAddress = Self.activePrivateIPv4(), Self.isPrivateIPv4(localAddress) else {
                call.reject("No active private IPv4 subnet is available")
                return
            }
            let octets = localAddress.split(separator: ".")
            guard octets.count == 4 else {
                call.reject("The active network is not an IPv4 /24")
                return
            }
            let prefix = octets.prefix(3).joined(separator: ".")
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = concurrency
            queue.qualityOfService = .userInitiated
            let lock = NSLock()
            var hosts: [[String: Any]] = []
            for host in 1...254 {
                let address = "\(prefix).\(host)"
                if address == localAddress { continue }
                queue.addOperation {
                    let ports = Self.allowedPorts.filter { Self.tcpPortIsOpen(address: address, port: $0, timeoutMs: timeoutMs) }
                    guard !ports.isEmpty else { return }
                    lock.lock()
                    hosts.append(["address": address, "ports": ports])
                    lock.unlock()
                }
            }
            queue.waitUntilAllOperationsAreFinished()
            call.resolve(["subnet": "\(prefix).0/24", "hosts": hosts.sorted { ($0["address"] as? String ?? "") < ($1["address"] as? String ?? "") }])
        }
    }

    private static func ssdpSearch(timeoutMs: Int) throws -> [[String: Any]] {
        let descriptor = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard descriptor >= 0 else { throw DiscoveryError.socket }
        defer { close(descriptor) }
        var receiveTimeout = timeval(tv_sec: 0, tv_usec: 250_000)
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &receiveTimeout, socklen_t(MemoryLayout<timeval>.size))
        var destination = sockaddr_in()
        destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        destination.sin_family = sa_family_t(AF_INET)
        destination.sin_port = in_port_t(1900).bigEndian
        guard inet_pton(AF_INET, "239.255.255.250", &destination.sin_addr) == 1 else { throw DiscoveryError.address }
        for target in ["upnp:rootdevice", "urn:schemas-upnp-org:device:MediaServer:1"] {
            let bytes = Array("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: \(target)\r\n\r\n".utf8)
            bytes.withUnsafeBytes { buffer in
                withUnsafePointer(to: &destination) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                        _ = sendto(descriptor, buffer.baseAddress, buffer.count, 0, address, socklen_t(MemoryLayout<sockaddr_in>.size))
                    }
                }
            }
        }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        var unique: [String: [String: Any]] = [:]
        var buffer = [UInt8](repeating: 0, count: 8192)
        while Date() < deadline {
            var source = sockaddr_in()
            var sourceLength = socklen_t(MemoryLayout<sockaddr_in>.size)
            let count = withUnsafeMutablePointer(to: &source) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                    recvfrom(descriptor, &buffer, buffer.count, 0, address, &sourceLength)
                }
            }
            if count <= 0 { continue }
            let headers = parseHeaders(String(decoding: buffer.prefix(Int(count)), as: UTF8.self))
            let address = ipv4String(source.sin_addr)
            guard isPrivateIPv4(address) else { continue }
            let location = headers["location"] ?? ""
            unique["\(address)|\(location)"] = ["address": address, "location": location, "server": headers["server"] ?? "", "st": headers["st"] ?? "", "usn": headers["usn"] ?? ""]
        }
        return Array(unique.values)
    }

    private static func parseHeaders(_ message: String) -> [String: String] {
        var headers: [String: String] = [:]
        for line in message.components(separatedBy: .newlines).dropFirst() {
            guard let separator = line.firstIndex(of: ":") else { continue }
            let key = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            headers[key] = line[line.index(after: separator)...].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return headers
    }

    private static func tcpPortIsOpen(address: String, port: Int, timeoutMs: Int) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        var destination = sockaddr_in()
        destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        destination.sin_family = sa_family_t(AF_INET)
        destination.sin_port = in_port_t(port).bigEndian
        guard inet_pton(AF_INET, address, &destination.sin_addr) == 1 else { return false }
        let result = withUnsafePointer(to: &destination) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if result == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
        guard poll(&pollDescriptor, 1, Int32(timeoutMs)) > 0 else { return false }
        var socketError: Int32 = 0
        var errorLength = socklen_t(MemoryLayout<Int32>.size)
        return getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) == 0 && socketError == 0
    }

    private static func activePrivateIPv4() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }
        var candidates: [(Int, String)] = []
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            let value = interface.pointee
            if let pointer = value.ifa_addr, pointer.pointee.sa_family == UInt8(AF_INET), (value.ifa_flags & UInt32(IFF_UP)) != 0, (value.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 {
                let address = pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { ipv4String($0.pointee.sin_addr) }
                if isPrivateIPv4(address) {
                    let name = String(cString: value.ifa_name)
                    candidates.append((name == "en0" ? 3 : name.hasPrefix("en") ? 2 : 1, address))
                }
            }
            current = value.ifa_next
        }
        return candidates.sorted { $0.0 > $1.0 }.first?.1
    }

    private static func activeInterfaceNames() -> [String] {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return [] }
        defer { freeifaddrs(interfaces) }
        var names = Set<String>()
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            let value = interface.pointee
            if (value.ifa_flags & UInt32(IFF_UP)) != 0, (value.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 {
                names.insert(String(cString: value.ifa_name))
            }
            current = value.ifa_next
        }
        return Array(names)
    }

    private static func ipv4String(_ address: in_addr) -> String {
        var value = address
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &value, &buffer, socklen_t(INET_ADDRSTRLEN))
        return String(cString: buffer)
    }

    private static func isPrivateIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || parts[0] == 127 || (parts[0] == 169 && parts[1] == 254) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
    }

    private static func clamp(_ value: Int, minimum: Int, maximum: Int) -> Int { max(minimum, min(maximum, value)) }
    private enum DiscoveryError: Error { case socket, address }
}
