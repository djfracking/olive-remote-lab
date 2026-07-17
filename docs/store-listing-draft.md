# Store listing draft

## Shared identity

- Name: Olive Remote Lab
- Category: Music
- Support URL: https://olive-remote-lab.web.app
- Privacy URL: https://olive-remote-lab.web.app/privacy
- Source and issue tracking: https://github.com/djfracking/olive-remote-lab

## Short description / subtitle

Private local-network remote for legacy music servers.

## Full description

Olive Remote Lab reconnects modern phones and tablets with compatible legacy music servers on the same local network.

Find a server automatically, connect manually when needed, browse the available library interface, inspect now-playing information, and control verified playback functions. The built-in protocol tools can test known web surfaces and export redacted diagnostics when a firmware version needs investigation.

Privacy is part of the architecture. There is no account, advertising, analytics, cloud library, or remote relay. Server addresses, library information, request history, and playback traffic remain on the device and local network unless the user explicitly exports a diagnostic file.

Compatibility is evidence-gated. The O4HD is the first physically exercised model. Other model profiles remain clearly marked until their firmware behavior is safely observed.

Olive Remote Lab is an independent compatibility project. It does not use vendor logos and is not affiliated with or endorsed by the original hardware manufacturer.

## Keywords

music server, local network, remote control, UPnP, SSDP, music library, legacy audio

## Review notes

The app controls user-owned hardware on the same private Wi-Fi or Ethernet network. It intentionally has no cloud login or public demo server. Manual connection, settings, compatibility information, diagnostics, and offline behavior can be reviewed without hardware. Live discovery, library metadata, and playback require a compatible server on the review device's LAN.

The app requests local-network access because it sends SSDP discovery packets and local HTTP requests only to private-network devices. Conservative fallback discovery checks only the current private IPv4 `/24`, ports 80 and 8163, and the three known paths `/`, `/maestro.php`, and `/index.php`.

## Prepared media

- `store-assets/ios/iphone-16-plus-now-playing.jpg` — native iPhone 16 Plus simulator capture after safe-area validation.

Additional tablet, Android phone, library, discovery, and playback screenshots should be captured from physical release candidates before submission.

## Privacy answers

- Data linked to the user: none.
- Tracking: none.
- Third-party advertising or analytics SDKs: none.
- Account creation: none.
- Cloud storage or relay: none.
- Local device data: server address, settings, request history, and diagnostics stored only on the user's device.
- User-controlled export: redacted diagnostics JSON.

These answers must be rechecked against the final binary and the then-current App Store Connect and Play Console questionnaires before submission.
