package com.djfracking.oliveremotelab;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URLEncoder;
import java.net.URL;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class OlivePlaybackService extends Service {
    public static final String ACTION_UPDATE = "com.djfracking.oliveremotelab.playback.UPDATE";
    public static final String ACTION_ACKNOWLEDGE = "com.djfracking.oliveremotelab.playback.ACKNOWLEDGE";
    private static final String ACTION_PLAY_PAUSE = "com.djfracking.oliveremotelab.playback.PLAY_PAUSE";
    private static final String ACTION_PREVIOUS = "com.djfracking.oliveremotelab.playback.PREVIOUS";
    private static final String ACTION_NEXT = "com.djfracking.oliveremotelab.playback.NEXT";
    private static final String ACTION_STOP = "com.djfracking.oliveremotelab.playback.STOP";
    private static final String CHANNEL_ID = "olive_playback";
    private static final int NOTIFICATION_ID = 4104;
    private static final long METADATA_RECONCILE_INTERVAL_MS = 4_000;
    private static final Pattern CURRENT_ITEM_PATTERN = Pattern.compile(
            "inf_showcurrentplaying\\(\\s*(['\"])(.*?)\\1\\s*\\)",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL
    );
    private static final long PLAYBACK_ACTIONS = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_STOP;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<String> pendingCommands = new HashSet<>();
    private MediaSession mediaSession;
    private String host = "";
    private int port = 80;
    private String itemId = "";
    private String title = "Playing on Olive";
    private String artist = "";
    private String album = "";
    private String artworkUrl = "";
    private Bitmap artwork;
    private int playbackState = PlaybackState.STATE_STOPPED;
    private long positionMs = 0;
    private long durationMs = 0;
    private long stateUpdatedAt = SystemClock.elapsedRealtime();
    private boolean reconciliationPending = false;
    private final Runnable reconciliationLoop = new Runnable() {
        @Override public void run() {
            reconcileMetadata();
            handler.postDelayed(this, METADATA_RECONCILE_INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        if (notifications != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Olive playback", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Controls music playing on your Olive");
            channel.setShowBadge(false);
            notifications.createNotificationChannel(channel);
        }
        mediaSession = new MediaSession(this, "OliveRemotePlayback");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { dispatchCommand("toggle", -1); }
            @Override public void onPause() { dispatchCommand("toggle", -1); }
            @Override public void onSkipToPrevious() { dispatchCommand("previous", -1); }
            @Override public void onSkipToNext() { dispatchCommand("next", -1); }
            @Override public void onStop() { dispatchCommand("stop", -1); }
            @Override public void onCustomAction(String action, android.os.Bundle extras) {
                if (ACTION_STOP.equals(action)) dispatchCommand("stop", -1);
            }
        });
        Intent activityIntent = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        mediaSession.setSessionActivity(PendingIntent.getActivity(this, 0, activityIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        mediaSession.setActive(true);
        handler.postDelayed(reconciliationLoop, METADATA_RECONCILE_INTERVAL_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_UPDATE.equals(action)) updateFrom(intent);
        else if (ACTION_ACKNOWLEDGE.equals(action)) pendingCommands.remove(stringExtra(intent, "commandId", ""));
        else if (ACTION_PLAY_PAUSE.equals(action)) dispatchCommand("toggle", -1);
        else if (ACTION_PREVIOUS.equals(action)) dispatchCommand("previous", -1);
        else if (ACTION_NEXT.equals(action)) dispatchCommand("next", -1);
        else if (ACTION_STOP.equals(action)) dispatchCommand("stop", -1);
        return START_NOT_STICKY;
    }

    private void updateFrom(Intent intent) {
        host = intent.getStringExtra("host");
        port = intent.getIntExtra("port", 80);
        itemId = stringExtra(intent, "itemId", "");
        title = stringExtra(intent, "title", "Playing on Olive");
        artist = stringExtra(intent, "artist", "");
        album = stringExtra(intent, "album", "");
        String incomingArtworkUrl = stringExtra(intent, "artworkUrl", "");
        String state = stringExtra(intent, "state", "unknown");
        playbackState = "playing".equals(state) ? PlaybackState.STATE_PLAYING
                : "paused".equals(state) ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_STOPPED;
        positionMs = Math.max(0, Math.round(intent.getDoubleExtra("positionSeconds", 0) * 1000));
        durationMs = Math.max(0, Math.round(intent.getDoubleExtra("durationSeconds", 0) * 1000));
        long sampledAt = Math.round(intent.getDoubleExtra("sampledAt", System.currentTimeMillis()));
        stateUpdatedAt = SystemClock.elapsedRealtime() - Math.max(0, System.currentTimeMillis() - sampledAt);
        if (!incomingArtworkUrl.equals(artworkUrl)) {
            artworkUrl = incomingArtworkUrl;
            artwork = null;
            loadArtwork(incomingArtworkUrl, itemId);
        }
        OlivePlaybackPlugin.updateSnapshot(
                host, port, itemId, title, artist, album, artworkUrl, state,
                positionMs / 1000d, durationMs / 1000d, sampledAt
        );
        publishState();
        handler.postDelayed(this::reconcileMetadata, 600);
    }

    private void dispatchCommand(String action, long incomingPositionMs) {
        if (host == null || host.isEmpty()) return;
        if ("seek".equals(action)) return;
        handler.post(() -> {
            String id = UUID.randomUUID().toString();
            pendingCommands.add(id);
            if (!OlivePlaybackPlugin.emitCommand(id, action, incomingPositionMs)) {
                pendingCommands.remove(id);
                performFallback(action, incomingPositionMs);
                return;
            }
            handler.postDelayed(() -> {
                if (pendingCommands.remove(id)) performFallback(action, incomingPositionMs);
            }, 800);
            handler.postDelayed(this::reconcileMetadata, 1_200);
            handler.postDelayed(this::reconcileMetadata, 3_000);
        });
    }

    private void performFallback(String action, long incomingPositionMs) {
        String nativeAction = "toggle".equals(action) ? "pause" : action;
        if ("toggle".equals(action)) {
            playbackState = playbackState == PlaybackState.STATE_PLAYING
                    ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_PLAYING;
        } else if ("stop".equals(action)) {
            playbackState = PlaybackState.STATE_STOPPED;
            positionMs = 0;
        } else {
            positionMs = 0;
        }
        stateUpdatedAt = SystemClock.elapsedRealtime();
        publishState();
        executeCommand(nativeAction);
    }

    private void publishState() {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, itemId)
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION, album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (!artworkUrl.isEmpty()) metadata.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, artworkUrl);
        if (artwork != null) metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        mediaSession.setMetadata(metadata.build());
        PlaybackState.CustomAction stopAction = new PlaybackState.CustomAction.Builder(ACTION_STOP, "Stop", R.drawable.ic_media_stop).build();
        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(PLAYBACK_ACTIONS)
                .addCustomAction(stopAction)
                .setState(playbackState, positionMs, playbackState == PlaybackState.STATE_PLAYING ? 1f : 0f, stateUpdatedAt)
                .build());
        Notification notification = buildNotification();
        startForeground(NOTIFICATION_ID, notification);
    }

    private Notification buildNotification() {
        boolean playing = playbackState == PlaybackState.STATE_PLAYING;
        Notification.Action previous = action(R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS, 1);
        Notification.Action playPause = action(playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play, playing ? "Pause" : "Play", ACTION_PLAY_PAUSE, 2);
        Notification.Action next = action(R.drawable.ic_media_next, "Next", ACTION_NEXT, 3);
        Notification.Action stop = action(R.drawable.ic_media_stop, "Stop", ACTION_STOP, 4);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_olive)
                .setContentTitle(title)
                .setContentText(artist.isEmpty() ? album : artist)
                .setContentIntent(contentIntent)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .addAction(previous).addAction(playPause).addAction(next).addAction(stop)
                .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        if (artwork != null) builder.setLargeIcon(artwork);
        return builder.build();
    }

    private Notification.Action action(int icon, String title, String action, int requestCode) {
        Intent intent = new Intent(this, OlivePlaybackService.class).setAction(action);
        PendingIntent pending = PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(icon, title, pending).build();
    }

    private void executeCommand(String action) {
        String currentHost = host;
        int currentPort = port;
        worker.execute(() -> {
            Set<Integer> ports = new LinkedHashSet<>();
            ports.add(currentPort); ports.add(80); ports.add(8163);
            for (int candidate : ports) if (request(action, currentHost, candidate)) return;
        });
    }

    private boolean request(String action, String address, int candidatePort) {
        HttpURLConnection connection = null;
        try {
            String query;
            if ("pause".equals(action)) query = "action=controlPlayer&root=null&upnpid=null&sortCrit=%2Bupnp%3AoriginalTrackNumber&index=0";
            else if ("stop".equals(action)) query = "action=controlPlayer&id=stop";
            else if ("previous".equals(action)) query = "action=left_skip";
            else if ("next".equals(action)) query = "action=right_skip";
            else return false;
            URL url = new URL("http", address, candidatePort, "/includes/ajax/a_executeOperation.php?" + query);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            return status >= 200 && status < 400;
        } catch (Exception ignored) { return false; }
        finally { if (connection != null) connection.disconnect(); }
    }

    private void reconcileMetadata() {
        if (reconciliationPending || host == null || host.isEmpty()
                || playbackState == PlaybackState.STATE_STOPPED) return;
        reconciliationPending = true;
        String expectedHost = host;
        int expectedPort = port;
        worker.execute(() -> {
            NativeMetadata incoming = fetchMetadata(expectedHost, expectedPort);
            handler.post(() -> {
                reconciliationPending = false;
                if (incoming == null || !expectedHost.equals(host)) return;
                boolean changed = !incoming.itemId.equals(itemId)
                        || !incoming.title.equals(title)
                        || !incoming.artist.equals(artist)
                        || !incoming.album.equals(album);
                if (!changed) return;
                itemId = incoming.itemId;
                title = incoming.title.isEmpty() ? "Playing on Olive" : incoming.title;
                artist = incoming.artist;
                album = incoming.album;
                if (!incoming.artworkUrl.equals(artworkUrl)) {
                    artworkUrl = incoming.artworkUrl;
                    artwork = null;
                    loadArtwork(artworkUrl, itemId);
                }
                OlivePlaybackPlugin.updateSnapshot(
                        host,
                        port,
                        itemId,
                        title,
                        artist,
                        album,
                        artworkUrl,
                        playbackState == PlaybackState.STATE_PLAYING ? "playing"
                                : playbackState == PlaybackState.STATE_PAUSED ? "paused" : "stopped",
                        positionMs / 1000d,
                        durationMs / 1000d,
                        System.currentTimeMillis()
                );
                publishState();
            });
        });
    }

    private NativeMetadata fetchMetadata(String address, int preferredPort) {
        Set<Integer> ports = new LinkedHashSet<>();
        ports.add(preferredPort); ports.add(80); ports.add(8163);
        for (int candidatePort : ports) {
            try {
                String current = httpText(new URL("http", address, candidatePort, "/server/getcurrentplaying.php"), true);
                Matcher match = CURRENT_ITEM_PATTERN.matcher(current);
                if (!match.find()) continue;
                String currentItemId = match.group(2) == null ? "" : match.group(2).trim();
                if (currentItemId.isEmpty()) continue;
                String encodedId = URLEncoder.encode(currentItemId, "UTF-8");
                String details = httpText(new URL("http", address, candidatePort, "/server/getnewinfo.php?id=" + encodedId), false);
                NativeMetadata metadata = parseMetadata(details, currentItemId, address, candidatePort);
                if (metadata != null) return metadata;
            } catch (Exception ignored) { }
        }
        return null;
    }

    private String httpText(URL url, boolean post) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setConnectTimeout(2_000);
            connection.setReadTimeout(2_500);
            connection.setInstanceFollowRedirects(false);
            if (post) {
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(0);
                try (OutputStream output = connection.getOutputStream()) { output.flush(); }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 400) throw new IllegalStateException("Olive metadata request failed");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > 512 * 1024) throw new IllegalStateException("Olive metadata response was too large");
                    output.write(buffer, 0, count);
                }
                return output.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    private NativeMetadata parseMetadata(String body, String currentItemId, String address, int candidatePort) {
        int start = body.indexOf("new_info('");
        int end = body.lastIndexOf("');");
        if (start < 0 || end <= start + 10) return null;
        try {
            String payload = body.substring(start + 10, end).replace("\\'", "'");
            JSONObject root = new JSONObject(payload);
            JSONObject track = root.optJSONObject("track");
            if (track == null) track = root;
            String incomingTitle = firstString(track, "title", "track", "name");
            String incomingArtist = firstString(track, "artist", "interpreter", "performer");
            String incomingAlbum = firstString(track, "album", "albumname");
            String artworkPath = firstString(track, "albumart", "albumArt", "artwork", "artworkPath", "cover");
            String incomingArtwork = "";
            if (!artworkPath.isEmpty() && !artworkPath.toLowerCase().contains("artworknotfound.gif")) {
                incomingArtwork = artworkPath.startsWith("http://")
                        ? artworkPath
                        : "http://" + address + ":" + candidatePort + (artworkPath.startsWith("/") ? artworkPath : "/" + artworkPath);
            }
            return new NativeMetadata(currentItemId, incomingTitle, incomingArtist, incomingAlbum, incomingArtwork);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String firstString(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "").trim();
            if (!value.isEmpty()) return value;
        }
        return "";
    }

    private static final class NativeMetadata {
        final String itemId;
        final String title;
        final String artist;
        final String album;
        final String artworkUrl;

        NativeMetadata(String itemId, String title, String artist, String album, String artworkUrl) {
            this.itemId = itemId;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artworkUrl = artworkUrl;
        }
    }

    private void loadArtwork(String value, String expectedItemId) {
        if (value.isEmpty()) return;
        worker.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(value);
                InetAddress address = InetAddress.getByName(url.getHost());
                if (!(address instanceof Inet4Address) || !(address.isSiteLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress())) return;
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(2500);
                connection.setReadTimeout(5000);
                connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200) return;
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int total = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        total += count;
                        if (total > 8 * 1024 * 1024) return;
                        output.write(buffer, 0, count);
                    }
                    Bitmap incoming = BitmapFactory.decodeByteArray(output.toByteArray(), 0, output.size());
                    if (incoming != null && expectedItemId.equals(itemId)) {
                        artwork = incoming;
                        publishState();
                    }
                }
            } catch (Exception ignored) { }
            finally { if (connection != null) connection.disconnect(); }
        });
    }

    private static String stringExtra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null ? fallback : value;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        pendingCommands.clear();
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        worker.shutdownNow();
        super.onDestroy();
    }
}
