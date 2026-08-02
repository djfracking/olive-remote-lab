# Mobile store release handoff

The native projects are now present for Android and iOS. Both use the same React interface and typed Olive compatibility client. Local HTTP, SSDP discovery, and bounded private `/24` fallback discovery run on-device; no cloud relay or user account is involved.

## Android / Google Play

The permanent package ID is `com.djfracking.oliveremotelab`. Java 21 and the Android SDK are required.

1. Create and securely back up a private upload keystore outside Git.
2. Store its password in the macOS login Keychain under service `com.djfracking.oliveremotelab.play-upload` and account `olive-remote`.
3. Set `OLIVE_VERSION_CODE` and `OLIVE_VERSION_NAME` for each release.
4. Run `npm run android:release:keychain -w @olive-remote-lab/web` and validate the resulting `.aab` with bundletool.
5. Create the Play Console record, enroll in Play App Signing, complete the store listing and data-safety declaration, and upload first to an internal or closed test track.

The app currently targets API 36. It uses `INTERNET`, network-state, Wi-Fi-state, and multicast-state permissions for private-LAN discovery and control; it does not request location, Nearby Wi-Fi Devices, or the API 37 `ACCESS_LOCAL_NETWORK` permission. Revisit the local-network permission flow when the target SDK moves to API 37.

The 1.0.4 release bundle is upload-key signed and passes bundletool validation. It is at `apps/web/android/app/build/outputs/bundle/release/app-release.aab` with version code 12. The private keystore is ignored by Git and has a separate backup outside the repository. An unsigned bundle produced with `android:bundle:unsigned` is only a build check and must never be uploaded.

Google requires an upload-key-signed Android App Bundle for Play distribution. See [Prepare your app for release](https://developer.android.com/studio/publish/preparing), [Sign your app](https://developer.android.com/studio/publish/app-signing), and [Upload your app bundle](https://developer.android.com/studio/publish/upload-bundle).

## iOS / App Store

The permanent iOS bundle ID is `com.djfracking.oliveremote` under the DJFracking LLC team (`P6LHR45445`); the deployment target is iOS 15. Android retains `com.djfracking.oliveremotelab`. The project uses CocoaPods so it can build from the checked npm dependency rather than downloading external Capacitor binary frameworks.

1. Open `apps/web/ios/App/App.xcworkspace` in Xcode.
2. Select the owning Apple Developer team and register the bundle ID.
3. Request Apple's Multicast Networking entitlement for this bundle ID. SSDP requires it; the requested capability is preserved in `App.entitlements` for a later release.
4. Confirm automatic signing and provisioning on a physical iPhone and iPad.
5. Run `npm run ios:archive`, validate the archive, and upload it to App Store Connect.
6. Add the privacy details, product-page copy, screenshots, support URL, and review notes. Test through TestFlight before App Review.

Earlier simulator, development-signed device, and physical O4HD/iPad smoke tests succeeded on this Mac. The DJFracking LLC 1.0.4 build 10 archive and App Store export succeeded under team `P6LHR45445`, and the package was uploaded to App Store Connect on August 1, 2026. The no-data-collected privacy response was published on August 1, 2026. The `DJ Fracking Internal` TestFlight group has automatic distribution enabled, includes build 10, and contains `djfracking@gmail.com`. Five iPhone 6.5-inch screenshots and six iPad 13-inch screenshots are uploaded to version 1.0.4. Paid Apps, banking, U.S. Form W-9, and DSA compliance are active. Version `1.0.4 (10)` was submitted August 1, 2026 at $14.99 in the United States across 175 countries or regions with manual release selected, and showed **Waiting for Review** after submission. The user reports beta testing is complete.

Apple requires approval before an iOS app can use the multicast entitlement. See [Multicast Networking entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast), [TestFlight](https://developer.apple.com/testflight/), and [Submitting to the App Store](https://developer.apple.com/app-store/submitting/).

Version 1.0 Debug builds use `AppDebug.entitlements` and App Store builds use `AppStore.entitlements`, both without the restricted multicast capability. Automatic discovery still works through the bounded private `/24` fallback when SSDP is unavailable. Once Apple approves multicast for this bundle ID, point the Release configuration back to `App.entitlements` to enable SSDP in the distributed app.

## Store declarations

- The app has no accounts, advertising, analytics, cloud library, or remote control service.
- Device addresses, library metadata, request history, and diagnostics remain on the device unless the user explicitly exports diagnostics.
- The public Firebase site hosts product information, the privacy policy, and a support form backed by a narrowly scoped email-forwarding Function. It has no music-server relay or application database.
- The app must explain local-network access as necessary to find and control the user's own music server.

Draft listing copy, keywords, review notes, and privacy answers are in [store-listing-draft.md](store-listing-draft.md).
The exact offline review path is also captured in [app-review.md](app-review.md).

## Current final-review state

- Apple version `1.0.4 (10)` was submitted August 1, 2026 and showed **Waiting for Review** after submission. Paid Apps, banking, U.S. Form W-9, and DSA compliance are active; the app is configured for public distribution in 175 countries or regions at a $14.99 United States price with manual release selected.
- Google Play internal testing remains active with release `1.0.4 (12)` assigned to the one-user `DJ Fracking Internal` list.
- Google Play production release `1.0.4 (12)`, the $14.99 United States price, and all 172 eligible paid-app countries and regions were submitted August 1, 2026 and showed **In review** on August 2, 2026. The Advertising ID answer is **No** and Play reports no policy issues.
- The only bundle warning is the optional missing deobfuscation file for R8/ProGuard builds; the app does not use obfuscation.
- Apple is set to manual release. Google Play managed publishing is off, so approval may publish the full production rollout automatically.
- Google payout-bank verification remains an account-holder follow-up. No pre-launch report exists yet; use a closed-test artifact for a later release to generate one.
- Google has no explicit third-party-store preference, and the listing was automatically shared with Aptoide Games after the July 2026 deadline.
- The user reports beta testing is complete. The physical-device matrix below remains the documented release-quality checklist.

## Physical release gate

Do not move from beta testing to public release until all of the following pass on real devices:

- Discovery and manual connection on iPhone, iPad, Android phone, and Android tablet.
- Browse, search, artwork, play, pause, stop, previous, next, multi-server switching, and now-playing state against an O4HD.
- Offline, sleep, reboot, IP-change, timeout, and interrupted-Wi-Fi recovery.
- Diagnostic export redaction.
- At least one additional Olive model capture before claiming support for that model.
