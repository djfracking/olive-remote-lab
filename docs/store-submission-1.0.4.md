# Olive Remote 1.0.4 store submission

Prepared and submitted August 1, 2026. This file records the artifacts, console declarations, and post-submission state for the first public release.

## Shared product setup

- Product name: Olive Remote
- Android package ID: `com.djfracking.oliveremotelab`
- iOS bundle ID: `com.djfracking.oliveremote`
- Category: Music
- Distribution: one-time paid download
- United States price: $14.99
- In-app purchases, subscriptions, advertising: none
- Support URL: https://olive-remote-lab.web.app/support
- Privacy URL: https://olive-remote-lab.web.app/privacy

## Google Play artifact

- Version name: 1.0.4
- Version code: 12
- Minimum Android: API 24
- Target Android: API 36
- Bundle: `apps/web/android/app/build/outputs/bundle/release/app-release.aab`
- Bundle SHA-256: `7578e73a5850f41eac1babd1006ba6ad35f8c9862b5a3f8f8f2f4695941cd764`
- Upload certificate: `store-assets/google-play/olive-upload-certificate.pem`
- Upload certificate SHA-256 fingerprint: `75:21:5A:22:6C:9B:8D:D5:79:E3:9B:AC:C8:88:BE:91:3E:07:1D:37:CC:64:89:04:B4:36:BF:87:D1:D2:CD:F4`
- Validation: signed bundle passes bundletool 1.18.1 validation
- Store icon: `store-assets/google-play/app-icon-512.png`
- Feature graphic: `store-assets/google-play/feature-graphic.png`
- Play-compliant phone screenshots: `store-assets/google-play/phone/` (five 1440 x 2560 PNGs)
- Play-compliant 7-inch tablet screenshots: `store-assets/google-play/tablet-7/` (four 2560 x 1440 PNGs)
- Play-compliant 10-inch tablet screenshots: `store-assets/google-play/tablet-10/` (four 2560 x 1440 PNGs)
- Internal tester list: `DJ Fracking Internal`, containing `djfracking@gmail.com`, assigned to the internal track
- Internal release: `1.0.4 (12)` is active and available to internal testers as of August 1, 2026
- Internal opt-in URL: https://play.google.com/apps/internaltest/4700318045714582599
- Production release: `1.0.4 (12)` was submitted August 1, 2026 and showed **In review** when checked August 2, 2026
- Production availability: all 172 eligible paid-app countries and regions are included in the submitted full rollout
- Production price: United States price is saved at $14.99
- Advertising ID declaration: **No** is saved
- Review state: Google accepted all 10 changes into review
- Play validation: no blocking errors; the only warning is the optional missing deobfuscation file for R8/ProGuard builds

The bundle remains available on the internal test track while the production release is in review. Google Play managed publishing is off, so approval may publish the full production rollout automatically.

## Apple artifact

- Version: 1.0.4
- Build: 10
- Minimum iOS: 15.0
- Devices: iPhone and iPad
- Archive: `apps/web/ios/output/OliveRemote-1.0.4-10.xcarchive`
- IPA: `apps/web/ios/output/OliveRemote-1.0.4-10-export/App.ipa`
- IPA SHA-256: `d78f5c2a0a6bf446a9cb62bd911d006c9783cc8cae2123904148b8453d6c2996`
- Export options: `apps/web/ios/ExportOptions-AppStore.plist`
- Upload options: `apps/web/ios/ExportOptions-AppStore-Upload.plist`
- Validation: DJFracking LLC App Store archive/export pass; the IPA is signed with a Cloud Managed Apple Distribution certificate for team `P6LHR45445`
- App Store Connect app ID: `6796952145`
- Apple team: DJFracking LLC (`P6LHR45445`)
- App Store Connect upload: succeeded August 1, 2026; build 10 is attached to version 1.0.4 and export compliance is resolved
- TestFlight internal group: `DJ Fracking Internal`, automatic distribution enabled, build 10 included, and `djfracking@gmail.com` added as an internal tester
- Product-page screenshots: five iPhone 6.5-inch screenshots and six iPad 13-inch screenshots uploaded
- Commercial setup: Paid Apps Agreement, bank account, U.S. Form W-9, and Digital Services Act compliance are active
- Availability and release: public distribution in 175 countries or regions at $14.99 in the United States, with manual release selected
- Review state: version `1.0.4 (10)` was submitted August 1, 2026 and showed **Waiting for Review** after submission
- Testing: the user reports beta testing is complete

Apple remains configured for manual release, so approval will still require the account holder to choose **Release This Version**.

## Console declarations

- Apple App Privacy: no data collected; no tracking. Published August 1, 2026 by DJ Fracking.
- Google Play Data safety: no data collected or shared by the app.
- Account requirement: none.
- Ads: no.
- News app: no.
- Government app: no.
- Health features: none.
- Financial features: none.
- Google Play target audience: 18 and over; the app is not designed for children.
- Google Play IARC rating: completed August 1, 2026; Everyone / PEGI 3 / regional equivalents.
- Google Play public support email: `djfracking@gmail.com`.
- Google Play public support site: https://olive-remote-lab.web.app/support
- App access: all preview functionality is available without credentials or hardware by choosing **Preview without a server**.

Recheck these answers against the final console wording before saving each questionnaire.

## Post-submission follow-up

- Monitor `djfracking@gmail.com` and both consoles for reviewer questions or required changes.
- Google Play managed publishing is off, so an approved production release may publish automatically.
- Apple remains configured for manual release after approval.
- Complete Google payout-bank verification when Google makes the verification step available.
- Google reports no policy issues. For a later update, create a closed-test release to generate a pre-launch report and evaluate R8/resource shrinking; the current bundle is 2.98 MB but Play labels its optimization **Low**.
- Select an explicit Google Play third-party-store preference. The listing was automatically shared with Aptoide Games after the July 2026 deadline because no preference was selected.
