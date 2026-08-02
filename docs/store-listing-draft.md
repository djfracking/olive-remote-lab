# Store listing draft

## Shared identity

- Name: Olive Remote
- Category: Music
- Support URL: https://olive-remote-lab.web.app
- Privacy URL: https://olive-remote-lab.web.app/privacy
- Source and issue tracking: https://github.com/djfracking/olive-remote-lab

## Short description / subtitle

Private local-network remote for legacy music servers.

## Full description

Olive Remote reconnects modern phones and tablets with compatible legacy music servers on the same local network.

Find a server automatically, connect manually when needed, browse the available library interface, search albums and artists, inspect now-playing information, and control verified playback functions. Connection help and redacted diagnostic export are available from Settings.

Privacy is part of the architecture. There is no account, advertising, analytics, cloud library, or remote relay. Server addresses, library information, request history, and playback traffic remain on the device and local network unless the user explicitly exports a diagnostic file.

Compatibility is evidence-gated. The O4HD is the first physically exercised model. Other model profiles remain clearly marked until their firmware behavior is safely observed.

Olive Remote is an independent compatibility project. It does not use vendor logos and is not affiliated with or endorsed by the original hardware manufacturer.

## Keywords

music server, local network, remote control, UPnP, SSDP, music library, legacy audio

## Review notes

The app controls user-owned hardware on the same private Wi-Fi or Ethernet network. It intentionally has no cloud login or public demo server. A clearly labeled offline preview library is bundled for review and uses only fictional metadata.

Review path:

1. Launch the app. The Find My Olive screen appears on a clean installation.
2. Tap **Preview without a server** below the primary discovery button. Do not tap Find My Olive; no Local Network permission is required for the preview.
3. Review Now Playing, Library, Search, Playlists, artwork, live progress, play/pause, previous, next, stop, responsive tablet navigation, Settings, and the Add Music explanation.
4. A compact **Preview library · fictional content** indicator identifies the simulated local preview. Tap **Use my Olive** to return to physical-device setup.

The demo never sends a network request and contains no copyrighted recordings. Live discovery and control require compatible owner-supplied hardware on the review device's LAN. A physical O4HD and iPad were used for an earlier release smoke test; the final signed candidate must repeat that check.

The app requests local-network access because it sends SSDP discovery packets and local HTTP requests only to private-network devices. Conservative fallback discovery checks only the current private IPv4 `/24`, ports 80 and 8163, and the three known paths `/`, `/maestro.php`, and `/index.php`.

## Prepared media

- `store-assets/ios/iphone-6.5/01-find-my-olive.png` — 1284 × 2778 App Store 6.5-inch connection screen.
- `store-assets/ios/iphone-6.5/02-now-playing.png` — 1284 × 2778 App Store 6.5-inch Now Playing screen.
- `store-assets/ios/iphone-6.5/03-albums.png` — 1284 × 2778 App Store 6.5-inch album browser.
- `store-assets/ios/iphone-6.5/04-search.png` — 1284 × 2778 App Store 6.5-inch search results.
- `store-assets/ios/iphone-6.5/05-settings.png` — 1284 × 2778 App Store 6.5-inch Settings and support screen.
- `store-assets/ios/iphone-16-plus/01-find-my-olive.png` — 1290 × 2796 iPhone connection screen.
- `store-assets/ios/iphone-16-plus/02-now-playing.png` — 1290 × 2796 iPhone Now Playing screen.
- `store-assets/ios/iphone-16-plus/03-albums.png` — 1290 × 2796 iPhone album browser.
- `store-assets/ios/iphone-16-plus/04-search.png` — 1290 × 2796 iPhone search results.
- `store-assets/ios/iphone-16-plus/05-settings.png` — 1290 × 2796 iPhone Settings and support screen.
- `store-assets/ios/ipad-13/01-find-my-olive.png` — 2064 × 2752 iPad connection screen.
- `store-assets/ios/ipad-13/02-now-playing.png` — 2752 × 2064 iPad Now Playing screen.
- `store-assets/ios/ipad-13/03-library.png` — 2752 × 2064 iPad library overview.
- `store-assets/google-play/app-icon-512.png` — 512 × 512 Google Play store icon.
- `store-assets/google-play/feature-graphic.png` — 1024 × 500 Google Play feature graphic.

Use the `iphone-6.5` files for the current App Store iPhone screenshot slot; the `iphone-16-plus` files remain source captures. Android phone/tablet screenshots still need to be prepared from the signed release candidate. Final screenshots and listing claims must be checked against a physical release candidate before submission.

## Commercial terms

- Distribution model: one-time paid download.
- US launch price: $14.99 using the nearest available store price point.
- In-app purchases: none.
- Subscriptions: none.
- Advertising: none.

## Privacy answers

- Data linked to the user: none.
- Tracking: none.
- Third-party advertising or analytics SDKs: none.
- Account creation: none.
- Cloud storage or relay: none.
- Local device data: server address, settings, request history, and diagnostics stored only on the user's device.
- User-controlled export: redacted diagnostics JSON.
- Optional website support data: reply email, message, and optional name/device details supplied deliberately by the user and forwarded to the private support mailbox; not stored in an application database.

These answers must be rechecked against the final binary and the then-current App Store Connect and Play Console questionnaires before submission.
