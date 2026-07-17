package com.djfracking.oliveremotelab;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "OliveDiscovery")
public class OliveDiscoveryPlugin extends Plugin {
    private static final String SSDP_HOST = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final int[] ALLOWED_PORTS = new int[]{80, 8163};

    @PluginMethod
    public void networkStatus(PluginCall call) {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = manager == null ? null : manager.getActiveNetwork();
        NetworkCapabilities capabilities = active == null || manager == null ? null : manager.getNetworkCapabilities(active);
        JSObject result = new JSObject();
        result.put("localAddress", activePrivateIpv4());
        result.put("wifi", capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
        result.put("vpnActive", capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
        result.put("settingsLabel", "Open Wi-Fi Settings");
        call.resolve(result);
    }

    @PluginMethod
    public void openNetworkSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not open Wi-Fi settings", error);
        }
    }

    @PluginMethod
    public void discover(PluginCall call) {
        final int timeoutMs = clamp(call.getInt("timeoutMs", 1800), 500, 4000);
        new Thread(() -> {
            WifiManager.MulticastLock lock = null;
            try {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    lock = wifi.createMulticastLock("olive-remote-lab-ssdp");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }

                Map<String, JSObject> replies = new LinkedHashMap<>();
                try (MulticastSocket socket = new MulticastSocket()) {
                    socket.setReuseAddress(true);
                    socket.setSoTimeout(250);
                    InetAddress group = InetAddress.getByName(SSDP_HOST);
                    sendSearch(socket, group, "upnp:rootdevice");
                    sendSearch(socket, group, "urn:schemas-upnp-org:device:MediaServer:1");

                    long deadline = System.currentTimeMillis() + timeoutMs;
                    byte[] buffer = new byte[8192];
                    while (System.currentTimeMillis() < deadline) {
                        try {
                            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                            socket.receive(packet);
                            String message = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
                            Map<String, String> headers = parseHeaders(message);
                            String address = packet.getAddress().getHostAddress();
                            String location = headers.getOrDefault("location", "");
                            String key = address + "|" + location;
                            JSObject item = new JSObject();
                            item.put("address", address);
                            item.put("location", location);
                            item.put("server", headers.getOrDefault("server", ""));
                            item.put("st", headers.getOrDefault("st", ""));
                            item.put("usn", headers.getOrDefault("usn", ""));
                            replies.put(key, item);
                        } catch (java.net.SocketTimeoutException ignored) {
                            // Continue until the bounded discovery window closes.
                        }
                    }
                }

                JSObject result = new JSObject();
                result.put("localAddress", activePrivateIpv4());
                result.put("responses", new JSArray(new ArrayList<>(replies.values())));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Local SSDP discovery failed", error);
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
        }, "olive-ssdp").start();
    }

    @PluginMethod
    public void scanSubnet(PluginCall call) {
        final int timeoutMs = clamp(call.getInt("timeoutMs", 250), 100, 600);
        final int concurrency = clamp(call.getInt("concurrency", 16), 4, 18);
        new Thread(() -> {
            String localAddress = activePrivateIpv4();
            if (localAddress.isEmpty()) {
                call.reject("No active private IPv4 subnet is available");
                return;
            }
            String[] octets = localAddress.split("\\.");
            if (octets.length != 4) {
                call.reject("The active network is not an IPv4 /24");
                return;
            }
            String prefix = octets[0] + "." + octets[1] + "." + octets[2];
            ExecutorService pool = Executors.newFixedThreadPool(concurrency);
            List<Future<JSObject>> futures = new ArrayList<>();
            for (int host = 1; host <= 254; host++) {
                String address = prefix + "." + host;
                if (address.equals(localAddress)) continue;
                futures.add(pool.submit(() -> probeHost(address, timeoutMs)));
            }
            pool.shutdown();
            JSArray hosts = new JSArray();
            try {
                for (Future<JSObject> future : futures) {
                    JSObject host = future.get((timeoutMs * 2L) + 500L, TimeUnit.MILLISECONDS);
                    if (host != null) hosts.put(host);
                }
                JSObject result = new JSObject();
                result.put("subnet", prefix + ".0/24");
                result.put("hosts", hosts);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Conservative subnet scan failed", error);
            } finally {
                pool.shutdownNow();
            }
        }, "olive-subnet-scan").start();
    }

    private static void sendSearch(MulticastSocket socket, InetAddress group, String target) throws Exception {
        String payload = "M-SEARCH * HTTP/1.1\r\n" +
                "HOST: 239.255.255.250:1900\r\n" +
                "MAN: \"ssdp:discover\"\r\n" +
                "MX: 1\r\n" +
                "ST: " + target + "\r\n\r\n";
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        socket.send(new DatagramPacket(bytes, bytes.length, group, SSDP_PORT));
    }

    private static Map<String, String> parseHeaders(String message) {
        Map<String, String> headers = new LinkedHashMap<>();
        String[] lines = message.split("\\r?\\n");
        for (int i = 1; i < lines.length; i++) {
            int separator = lines[i].indexOf(':');
            if (separator > 0) {
                headers.put(lines[i].substring(0, separator).trim().toLowerCase(Locale.US), lines[i].substring(separator + 1).trim());
            }
        }
        return headers;
    }

    private static JSObject probeHost(String address, int timeoutMs) {
        JSArray openPorts = new JSArray();
        for (int port : ALLOWED_PORTS) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(address, port), timeoutMs);
                openPorts.put(port);
            } catch (Exception ignored) {
                // Closed or offline hosts are expected during the bounded scan.
            }
        }
        if (openPorts.length() == 0) return null;
        JSObject result = new JSObject();
        result.put("address", address);
        result.put("ports", openPorts);
        return result;
    }

    private static String activePrivateIpv4() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            interfaces.sort((left, right) -> scoreInterface(right) - scoreInterface(left));
            for (NetworkInterface network : interfaces) {
                if (!network.isUp() || network.isLoopback()) continue;
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address && address.isSiteLocalAddress() && !address.isLoopbackAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
            // The caller reports the absence of an active private subnet.
        }
        return "";
    }

    private static int scoreInterface(NetworkInterface network) {
        String name = network.getName().toLowerCase(Locale.US);
        if (name.startsWith("wlan") || name.startsWith("wifi")) return 3;
        if (name.startsWith("eth")) return 2;
        return 1;
    }

    private static int clamp(Integer value, int minimum, int maximum) {
        int actual = value == null ? minimum : value;
        return Math.max(minimum, Math.min(maximum, actual));
    }
}
