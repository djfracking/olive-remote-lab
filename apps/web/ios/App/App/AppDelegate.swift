import UIKit
import Capacitor
import Darwin

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
    }
}

@objc(OliveDiscoveryPlugin)
public class OliveDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OliveDiscoveryPlugin"
    public let jsName = "OliveDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanSubnet", returnType: CAPPluginReturnPromise),
    ]
    private let worker = DispatchQueue(label: "com.djfracking.oliveremotelab.discovery", qos: .userInitiated)
    private static let allowedPorts = [80, 8163]

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
