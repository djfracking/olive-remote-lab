package com.djfracking.oliveremotelab;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.ref.WeakReference;

@CapacitorPlugin(
        name = "OlivePlayback",
        permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class OlivePlaybackPlugin extends Plugin {
    private static WeakReference<OlivePlaybackPlugin> activePlugin = new WeakReference<>(null);
    private static String latestHost = "";
    private static int latestPort = 80;
    private static String latestItemId = "";
    private static String latestTitle = "";
    private static String latestArtist = "";
    private static String latestAlbum = "";
    private static String latestArtworkUrl = "";
    private static String latestState = "unknown";
    private static double latestPositionSeconds = 0;
    private static double latestDurationSeconds = 0;
    private static double latestSampledAt = 0;

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        startSession(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        startSession(call);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getContext().stopService(new Intent(getContext(), OlivePlaybackService.class));
        updateSnapshot("", 80, "", "", "", "", "", "stopped", 0, 0, System.currentTimeMillis());
        call.resolve();
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String id = call.getString("id", "");
        if (id.isEmpty()) {
            call.reject("A command id is required");
            return;
        }
        Intent intent = new Intent(getContext(), OlivePlaybackService.class)
                .setAction(OlivePlaybackService.ACTION_ACKNOWLEDGE)
                .putExtra("commandId", id);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void current(PluginCall call) {
        JSObject snapshot = new JSObject();
        synchronized (OlivePlaybackPlugin.class) {
            snapshot.put("host", latestHost);
            snapshot.put("port", latestPort);
            snapshot.put("itemId", latestItemId);
            snapshot.put("title", latestTitle);
            snapshot.put("artist", latestArtist);
            snapshot.put("album", latestAlbum);
            snapshot.put("artworkUrl", latestArtworkUrl);
            snapshot.put("state", latestState);
            snapshot.put("positionSeconds", latestPositionSeconds);
            snapshot.put("durationSeconds", latestDurationSeconds);
            snapshot.put("sampledAt", latestSampledAt);
        }
        call.resolve(snapshot);
    }

    static boolean emitCommand(String id, String action, long positionMs) {
        OlivePlaybackPlugin plugin = activePlugin.get();
        if (plugin == null) return false;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("action", action);
        if (positionMs >= 0) event.put("positionSeconds", positionMs / 1000d);
        plugin.notifyListeners("command", event);
        return true;
    }

    static synchronized void updateSnapshot(
            String host,
            int port,
            String itemId,
            String title,
            String artist,
            String album,
            String artworkUrl,
            String state,
            double positionSeconds,
            double durationSeconds,
            double sampledAt
    ) {
        latestHost = host == null ? "" : host;
        latestPort = port;
        latestItemId = itemId == null ? "" : itemId;
        latestTitle = title == null ? "" : title;
        latestArtist = artist == null ? "" : artist;
        latestAlbum = album == null ? "" : album;
        latestArtworkUrl = artworkUrl == null ? "" : artworkUrl;
        latestState = state == null ? "unknown" : state;
        latestPositionSeconds = Math.max(0, positionSeconds);
        latestDurationSeconds = Math.max(0, durationSeconds);
        latestSampledAt = sampledAt;
    }

    private void startSession(PluginCall call) {
        JSObject target = call.getObject("target");
        String host = target == null ? "" : target.getString("host", "");
        int port = target == null ? 80 : target.getInteger("port", 80);
        if (!isPrivateHost(host) || port < 1 || port > 65535) {
            call.reject("A private Olive address and valid port are required");
            return;
        }

        Intent intent = new Intent(getContext(), OlivePlaybackService.class);
        intent.setAction(OlivePlaybackService.ACTION_UPDATE);
        intent.putExtra("host", host);
        intent.putExtra("port", port);
        intent.putExtra("itemId", call.getString("itemId", ""));
        intent.putExtra("title", call.getString("title", "Playing on Olive"));
        intent.putExtra("artist", call.getString("artist", ""));
        intent.putExtra("album", call.getString("album", ""));
        intent.putExtra("artworkUrl", call.getString("artworkUrl", ""));
        intent.putExtra("state", call.getString("state", "unknown"));
        Double position = call.getDouble("positionSeconds");
        Double duration = call.getDouble("durationSeconds");
        intent.putExtra("positionSeconds", position == null ? 0d : position);
        intent.putExtra("durationSeconds", duration == null ? 0d : duration);
        Double sampledAt = call.getDouble("sampledAt", (double) System.currentTimeMillis());
        intent.putExtra("sampledAt", sampledAt == null ? (double) System.currentTimeMillis() : sampledAt.doubleValue());
        updateSnapshot(
                host,
                port,
                call.getString("itemId", ""),
                call.getString("title", "Playing on Olive"),
                call.getString("artist", ""),
                call.getString("album", ""),
                call.getString("artworkUrl", ""),
                call.getString("state", "unknown"),
                position == null ? 0d : position,
                duration == null ? 0d : duration,
                sampledAt == null ? (double) System.currentTimeMillis() : sampledAt
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
        else getContext().startService(intent);
        call.resolve();
    }

    private static boolean isPrivateHost(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase();
        if (normalized.endsWith(".local")) return true;
        String[] parts = normalized.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < 4; index++) {
                octets[index] = Integer.parseInt(parts[index]);
                if (octets[index] < 0 || octets[index] > 255) return false;
            }
        } catch (NumberFormatException ignored) { return false; }
        return octets[0] == 10 || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
    }
}
