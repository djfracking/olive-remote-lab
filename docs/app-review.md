# App Store reviewer environment

Olive Remote includes an explicit offline Demo Olive so Apple and Google reviewers can evaluate the main experience without discontinued physical hardware or access to a private home network.

## Reviewer steps

1. Install and launch Olive Remote on a clean device.
2. On **Find My Olive**, tap **Explore Demo Olive**.
3. Browse Albums, Artists, Genres, Tracks, and Playlists.
4. Search for `light`, `north`, `jazz`, or `night`.
5. Start a track and test play/pause, previous, next, stop, progress, title changes, and artwork.
6. Open Settings to inspect device switching and language choices.
7. Open Add Music to see the demo-specific explanation.
8. Tap **Connect a real Olive** in the persistent banner to leave Demo Mode.

## Review guarantees

- Demo Mode is plainly labeled throughout the experience.
- All demo titles, artists, albums, playlists, and artwork are fictional and bundled with the application.
- No audio recording, copyrighted music, external server, analytics, advertising, user account, or cloud service is used.
- Demo API calls use the same typed application boundary as real hardware but are intercepted locally before any network transport.
- Demo Mode never requests Local Network permission.
- The real application communicates only with owner-selected devices on a private local network.

## Physical-hardware context

The release candidate was exercised on an iPad Pro against an O4HD on the same private network. Real discovery, library browsing, artwork, search, now-playing state, and playback controls require compatible owner-supplied hardware. Review attachments should include a short screen recording of that physical test and the O4HD network screen with personal addresses obscured.

## App Review contact checklist

Before submission, App Store Connect still needs:

- A monitored review contact name, phone number, and email address.
- The review steps above pasted into App Review Notes.
- A demo-mode screen recording and a redacted real-hardware recording attached when possible.
- Confirmation that no demo account or credentials are required.
