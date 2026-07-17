# Olive Remote Lab

A browser-first, local-network controller and protocol explorer for the complete known Olive music-server family. The O4HD is the first physically verified model; every other model is represented by an evidence-gated profile so the app does not guess across firmware generations.

[Public website](https://olive-remote-lab.web.app) · [Android test APK](https://github.com/djfracking/olive-remote-lab/releases/tag/v0.1.0-test) · [Source repository](https://github.com/djfracking/olive-remote-lab) · [Privacy policy](https://olive-remote-lab.web.app/privacy)

Everything runs on your computer and LAN. There are no accounts, analytics, cloud services, remote fonts, or external API calls.

Native Android and iOS projects are included. See [mobile store release handoff](docs/store-release.md) for signing, TestFlight, Play Console, entitlement, and physical-device release gates.

The Firebase-hosted website is only the public project and download page. It is not a cloud relay and cannot control a server: modern browsers block a public HTTPS origin from silently reaching legacy private-network HTTP devices. Use the Android app or run this repository locally for control.

## Quick start

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) on the computer running the app. Vite serves the React interface and forwards `/api` to the Express proxy on port 3001. Both development servers bind to `0.0.0.0`.

Other useful commands:

```bash
npm test
npm run typecheck
npm run build
```

## Android app

The Android build is a real local-network app, not a bookmark to the web interface. It bundles the React interface and uses native HTTP plus SSDP/subnet discovery, so the Mac and Node proxy do not need to remain running after installation.

Build a debug-signed APK with:

```bash
npm run android:debug
```

The installable file is generated at:

```text
apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

With Android platform tools and USB debugging enabled, install or update it with:

```bash
adb install -r apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Connect the Android phone/tablet and the music server to the same trusted Wi-Fi or Ethernet LAN. Open the app and choose **Find my Olive**; if multicast discovery is unavailable, enter the device IP manually. The Android app talks only to private LAN addresses over the legacy server's HTTP interface.

The debug APK is suitable for direct testing and sideloading. Building it requires Java 21. Google Play distribution requires a private release signing key and a signed Android App Bundle; see [docs/android-release.md](docs/android-release.md).

## Open from an iPad on the same Wi-Fi

1. Connect the Mac/PC, iPad, and music server to the same trusted Wi-Fi/LAN.
2. Run `npm run dev` and note the `Network` URL printed by Vite, such as `http://192.168.1.20:3000`.
3. If needed, find the computer's address in macOS **System Settings → Network → Wi-Fi → Details → TCP/IP**.
4. Open that `http://COMPUTER-IP:3000` URL in Safari on the iPad. Do not use `localhost` on the iPad; that points to the iPad itself.
5. Optional: in Safari use **Share → Add to Home Screen**. The production build includes a service worker and web app manifest.

Your OS firewall may ask whether Node can accept incoming connections. Allow access only on trusted/private networks.

## Using the explorer

- **Find my Olive:** sends SSDP M-SEARCH for UPnP root and MediaServer devices. It inspects local device-description XML. If no likely device is found, it checks only the active private IPv4 `/24`, ports `80` and `8163`, and paths `/`, `/maestro.php`, and `/index.php`. It uses short timeouts and bounded concurrency.
- **Manual fallback:** enter the server IP (for example `192.168.1.42`) and port in **Connect a device**, then choose **Connect**. A confirmed device is remembered in that browser's local storage.
- **Endpoint tester:** requests the three known paths on the selected port and port 8163, showing status, type, timing, preview, and errors.
- **Library, Search, Now Playing and Playlists:** use the exact read contracts captured from the O4HD. Track play, play/pause, previous, stop and next are available from observed controller commands. Playlist editing remains locked.
- **Automatic everyday remote:** reconnects to the remembered device or performs conservative local discovery, then opens directly to Now Playing with five primary destinations.
- **Multilingual navigation:** English, French, German and Spanish are selected in Settings and remembered only in the browser.
- **Add Music:** shows the model-safe SMB Import-folder instructions for Mac, Windows and iPad/iPhone; it does not invent an HTTP upload endpoint.
- **Queue:** explains the current evidence gap. No playback-queue endpoint has been verified, so the app does not consume or acknowledge the device event stream.
- **Settings:** shows the connected model, protocol family, capability evidence, and the full compatibility registry.
- **Request explorer:** sends user-specified GET/POST requests through the local proxy. Query, form, and header entries use one `key=value` pair per line. This surface is explicitly experimental.
- **Diagnostics export:** choose **Export diagnostics JSON** in Protocol logging. The proxy exports in-memory logs for the current session and redacts likely names, library metadata, playlist fields, users, and email addresses.

## Project structure

```text
apps/web/                  React + TypeScript + Vite tablet-first PWA
  android/                 Capacitor Android shell and native LAN discovery plugin
apps/proxy/                Local Express HTTP proxy and LAN discovery
packages/olive-client/     Typed transport boundary, URL/parsing, probes and requests
docs/                      Protocol research and evidence requirements
```

All device-specific request construction and parsing lives in `packages/olive-client`. The proxy supplies the Node HTTP transport and discovery facilities. `OliveTransport` is the compatibility boundary for alternate firmware and models.

## Safety and privacy

- Device HTTP targets must resolve to private, loopback, or link-local addresses.
- Subnet fallback scans only the selected active private interface's `/24`.
- Discovery checks only ports 80 and 8163 and the three stated web paths.
- Redirects are not followed, preventing a device response from redirecting the proxy off-LAN.
- Logs live in proxy memory and request history/device selections live in browser local storage.
- Nothing is sent to Firebase or any other cloud service.

The public website is hosted by Firebase Hosting and necessarily receives ordinary web-delivery request metadata. It has no analytics, sign-in, database, functions, or music-server API. See [public-site/privacy.html](public-site/privacy.html).

## Multi-model support

The first real-device findings are documented in [docs/olive-4hd-protocol-map.md](docs/olive-4hd-protocol-map.md). The family registry and capture checklist are in [docs/model-compatibility.md](docs/model-compatibility.md), and remaining protocol evidence is tracked in [docs/protocol-evidence.md](docs/protocol-evidence.md).

The simple remote, local import workflow, and optional Apple Music/Spotify boundary are described in [docs/product-direction.md](docs/product-direction.md).

The complete customer journey, next-tier roadmap and non-negotiable platform boundaries are listed in [docs/customer-journey.md](docs/customer-journey.md).

To finish control support for every model, we still need temporary LAN access to one working example of each firmware family, its exact firmware version, and redacted diagnostics. The ONE is treated as a separate platform until its local interface is observed. Queue reading, volume, playlist writes, and device settings remain disabled wherever their request contracts are unverified. Play/pause is enabled for the verified O4HD front-panel contract only.

This project is independent diagnostic software and includes no vendor logos or copied visual assets.
