# Protocol evidence needed for control features

The Library, Search, Now Playing, Queue, Playlists, and Settings screens remain placeholders until the protocol is observed on real hardware. This avoids shipping guessed undocumented endpoints in the compatibility client.

## Safe capture procedure

Use the Request Explorer against a device you own on a trusted LAN. Export redacted diagnostics and review the JSON before sharing it. Remove titles, artist/album names, playlist names, user names, network credentials, serial numbers, and any other personal data that remains.

## Required evidence

1. **Identity and compatibility**
   - Exact model and firmware version.
   - Useful response headers and device-description XML.
   - Whether ports 80 and 8163 serve the same application.
   - Differences observed between 4HD and other models/firmware.

2. **Session behavior**
   - Whether requests need cookies, tokens, basic authentication, or a warm-up request.
   - Session expiry and concurrent-controller behavior.

3. **Library browsing and search**
   - Real request/response pairs for artists, albums, tracks, genres, composers, and folders.
   - Pagination, sort, filter, and total-count fields.
   - Character encoding and XML/JSON schema, including empty/error results.
   - Stable IDs used to connect artist, album, track, artwork, and filesystem records.

4. **Playback and state**
   - Observed commands for play, pause, stop, next, previous, seek, volume, and mute.
   - Now-playing polling/subscription behavior and state payloads.
   - Queue read/add/remove/reorder/clear operations and failure responses.
   - Zone or output selection if supported.

5. **Playlists and settings**
   - Playlist create/read/update/delete behavior and ordering.
   - Read-only versus mutating settings, with safe test cases.
   - Restart, rescan, delete, or other destructive commands must be identified and isolated before implementation.

6. **Artwork and media**
   - Artwork URL construction, MIME types, size variants, and missing-art behavior.
   - Any range request or streaming URL behavior needed for browser playback (if supported).

Each finding should be tagged **observed**, **inferred**, or **unknown**. Only repeatable observed behavior should move into production methods in `packages/olive-client`; exploratory methods remain clearly labeled experimental.
