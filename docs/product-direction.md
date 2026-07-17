# Simple remote product direction

## Everyday experience

The default application is a remote, not a protocol tool:

1. Reconnect to the last confirmed device.
2. If it is unavailable, run local SSDP discovery and the conservative private `/24` fallback.
3. Open directly to Now Playing.
4. Keep only five primary destinations: Now Playing, Library, Search, Playlists and Add Music.
5. Put model research, endpoint tests and diagnostics behind Settings → Protocol Lab.

This follows the platform pattern of using a small, stable set of top-level destinations and keeping playback controls predictable. Unsupported controls remain disabled instead of being repurposed.

## Languages

The core navigation currently supports English, French, German and Spanish, selected from browser language on first use and remembered locally. Device-protocol labels and the advanced lab remain in technical English while their response vocabulary is being mapped.

## Adding music

The verified HD-server workflow is the device's SMB `Import` folder:

- macOS: connect to `smb://DEVICE-IP` in Finder.
- Windows: open `\\DEVICE-IP`.
- iPadOS/iOS: try Files → Connect to Server; older SMB dialects may require a Mac or PC.

The server imports supported FLAC, WAV, MP3 and AAC files after they are copied into `Import`. Browser upload is not presented because no safe HTTP upload contract has been verified.

## Apple Music

MusicKit on the web can play Apple Music in a browser, but it is not local-only. It requires:

- an Apple Developer media identifier and signed developer token;
- user authorization and a Music User Token for personal library data;
- an active Apple Music capability/subscription where applicable;
- internet access to Apple services.

If added, Apple Music should be a separate opt-in playback source. It must not imply that protected Apple Music streams can be copied to or decoded by an Olive server.

## Spotify

The Spotify Web Playback SDK creates a Spotify Connect player in the browser. It requires:

- a registered Spotify developer application;
- OAuth authorization, preferably Authorization Code with PKCE for this browser-first app;
- a Spotify Premium user for browser playback;
- internet access and compliance with Spotify's developer and commercial-use policies.

Spotify Connect can transfer playback only to devices that Spotify recognizes as Connect devices. Legacy Olive models must not be presented as Spotify targets unless an actual supported receiver is discovered.

## Integration boundary

The local Olive remote remains the default and continues to work without any account. External providers, if enabled later, should be optional source adapters with separate authorization state, playback capabilities and privacy disclosures. Provider tokens must never enter protocol exports.
