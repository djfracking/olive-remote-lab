# Android build and release

## Architecture

The Android app packages the existing React/Vite interface with Capacitor. On Android, an in-process adapter replaces the development proxy:

- Capacitor native HTTP sends known protocol and explorer requests directly to private LAN hosts.
- `OliveDiscoveryPlugin` sends bounded SSDP searches and, only when needed, checks the active private IPv4 `/24`.
- The fallback scan is restricted to ports 80 and 8163; Olive identification is restricted to `/`, `/maestro.php`, and `/index.php`.
- Cleartext HTTP is enabled because the legacy hardware does not provide HTTPS.
- Confirmed devices, request history, settings, and diagnostics remain on the Android device.

No Firebase project, hosted API, account system, analytics SDK, or internet service is used.

## Local debug APK

Requirements:

- Node.js 20 or newer
- npm
- Java 21 with `JAVA_HOME` pointing to that installation
- Android SDK Platform 36 and Build Tools 36

From the repository root:

```bash
npm install
npm run android:debug
```

Output:

```text
apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a USB-connected device:

```bash
adb devices
adb install -r apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

For manual sideloading, copy the APK to the Android device and approve installation from that file source when Android asks. Keep the device and music server on the same trusted LAN.

## Google Play preparation

The repository can generate an unsigned validation bundle with `npm run android:bundle:unsigned`. The store command `npm run android:release` intentionally fails until a private upload key is configured.

Create the private configuration without committing it:

```bash
cp apps/web/android/signing.properties.example apps/web/android/signing.properties
```

Generate or select an upload keystore, then replace all placeholder values in `signing.properties`. The keystore and completed properties file are ignored by Git. A signed bundle is written to `apps/web/android/app/build/outputs/bundle/release/app-release.aab`.

Before publishing:

1. Choose the permanent application ID and confirm ownership of the product name.
2. Create and securely back up a release/upload key outside the repository.
3. Configure Gradle signing through uncommitted environment variables or a local properties file.
4. Set intentional `versionCode` and `versionName` values for every release.
5. Produce and test a signed `.aab` on physical Android phones and tablets across supported OS versions.
6. Complete the Play Console privacy, data-safety, content-rating, store-listing, and closed-testing requirements.
7. Publish a privacy policy explaining that device addresses, music metadata, and diagnostics remain local unless the user explicitly exports a file.

Never commit keystores, passwords, exported diagnostics, device IP addresses, or music-library data.

## Physical-device release checks

- Automatic SSDP discovery on Wi-Fi
- Conservative fallback discovery when SSDP is blocked
- Manual IP connection
- Library browsing, search, artwork, and long lists
- Track start plus play/pause, previous, stop, and next
- Recovery after the server sleeps, reboots, or changes address
- Phone portrait and tablet landscape layouts
- Android back navigation and lifecycle resume
- Diagnostics export and redaction
- Installation and upgrade without clearing remembered devices

Model support remains capability-gated. The O4HD is physically verified; additional models require safe protocol captures before their unverified controls are enabled.
