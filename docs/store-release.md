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
3. Request Apple's Multicast Networking entitlement for this bundle ID. SSDP requires it; the entitlement is already declared in `App.entitlements`.
4. Confirm automatic signing and provisioning on a physical iPhone and iPad.
5. Run `npm run ios:archive`, validate the archive, and upload it to App Store Connect.
6. Add the privacy details, product-page copy, screenshots, support URL, and review notes. Test through TestFlight before App Review.

The first archive attempt on this Mac confirmed that the source and simulator build succeed, but Xcode's App Store account session must be refreshed before it can create the provisioning profile. This is an account credential step, not a source-code failure.

Apple requires approval before an iOS app can use the multicast entitlement. See [Multicast Networking entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast), [TestFlight](https://developer.apple.com/testflight/), and [Submitting to the App Store](https://developer.apple.com/app-store/submitting/).

## Store declarations

- The app has no accounts, advertising, analytics, cloud library, or remote control service.
- Device addresses, library metadata, request history, and diagnostics remain on the device unless the user explicitly exports diagnostics.
- The public Firebase site hosts product information and the privacy policy only.
- The app must explain local-network access as necessary to find and control the user's own music server.

Draft listing copy, keywords, review notes, and privacy answers are in [store-listing-draft.md](store-listing-draft.md).

## Physical release gate

Do not move from beta testing to public release until all of the following pass on real devices:

- Discovery and manual connection on iPhone, iPad, Android phone, and Android tablet.
- Browse, search, artwork, play, pause, stop, previous, next, queue, and now-playing state against an O4HD.
- Offline, sleep, reboot, IP-change, timeout, and interrupted-Wi-Fi recovery.
- Diagnostic export redaction.
- At least one additional Olive model capture before claiming support for that model.
