# Mobile store release handoff

The native projects are now present for Android and iOS. Both use the same React interface and typed Olive compatibility client. Local HTTP, SSDP discovery, and bounded private `/24` fallback discovery run on-device; no cloud relay or user account is involved.

## Android / Google Play

The permanent package ID is `com.djfracking.oliveremotelab`. Java 21 and the Android SDK are required.

1. Create and securely back up a private upload keystore outside Git.
2. Copy `apps/web/android/signing.properties.example` to `apps/web/android/signing.properties` and supply the private values.
3. Set `OLIVE_VERSION_CODE` and `OLIVE_VERSION_NAME` for each release.
4. Run `npm run android:release` and verify the resulting `.aab` signature.
5. Create the Play Console record, enroll in Play App Signing, complete the store listing and data-safety declaration, and upload first to an internal or closed test track.

Google requires an upload-key-signed Android App Bundle for Play distribution. See [Prepare your app for release](https://developer.android.com/studio/publish/preparing), [Sign your app](https://developer.android.com/studio/publish/app-signing), and [Upload your app bundle](https://developer.android.com/studio/publish/upload-bundle).

## iOS / App Store

The permanent bundle ID is `com.djfracking.oliveremotelab`; the deployment target is iOS 15. The project uses CocoaPods so it can build from the checked npm dependency rather than downloading external Capacitor binary frameworks.

1. Open `apps/web/ios/App/App.xcworkspace` in Xcode.
2. Select the owning Apple Developer team and register the bundle ID.
3. Request Apple's Multicast Networking entitlement for this bundle ID. SSDP requires it; the requested capability is preserved in `App.entitlements` for a later release.
4. Confirm automatic signing and provisioning on a physical iPhone and iPad.
5. Run `npm run ios:archive`, validate the archive, and upload it to App Store Connect.
6. Add the privacy details, product-page copy, screenshots, support URL, and review notes. Test through TestFlight before App Review.

The source, simulator build, signed physical-device build, version 1.0.0 iOS archive, and physical O4HD/iPad smoke test have succeeded on this Mac. The remaining iOS release gates are rebuilding the archive from the final committed source, creating the App Store Connect record, final screenshots and metadata, distribution export/upload, TestFlight testing, and App Review.

Apple requires approval before an iOS app can use the multicast entitlement. See [Multicast Networking entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast), [TestFlight](https://developer.apple.com/testflight/), and [Submitting to the App Store](https://developer.apple.com/app-store/submitting/).

Version 1.0 Debug builds use `AppDebug.entitlements` and App Store builds use `AppStore.entitlements`, both without the restricted multicast capability. Automatic discovery still works through the bounded private `/24` fallback when SSDP is unavailable. Once Apple approves multicast for this bundle ID, point the Release configuration back to `App.entitlements` to enable SSDP in the distributed app.

## Store declarations

- The app has no accounts, advertising, analytics, cloud library, or remote control service.
- Device addresses, library metadata, request history, and diagnostics remain on the device unless the user explicitly exports diagnostics.
- The public Firebase site hosts product information and the privacy policy only.
- The app must explain local-network access as necessary to find and control the user's own music server.

Draft listing copy, keywords, review notes, and privacy answers are in [store-listing-draft.md](store-listing-draft.md).
The exact offline review path is also captured in [app-review.md](app-review.md).

## Physical release gate

Do not move from beta testing to public release until all of the following pass on real devices:

- Discovery and manual connection on iPhone, iPad, Android phone, and Android tablet.
- Browse, search, artwork, play, pause, stop, previous, next, multi-server switching, and now-playing state against an O4HD.
- Offline, sleep, reboot, IP-change, timeout, and interrupted-Wi-Fi recovery.
- Diagnostic export redaction.
- At least one additional Olive model capture before claiming support for that model.
