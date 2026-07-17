# Olive 4HD observed protocol map

Captured read-only on 2026-07-16 from a privately owned device. This document records observed behavior without retaining IP addresses, library names, track identifiers, or other personal library content.

## Confirmed platform

- The public interface identifies itself as `Olive OPUS` and contains `OPUS4HD_CODE_START_NOT_O6HD` build markers.
- HTTP server: `lighttpd/1.4.13`.
- Application runtime: `PHP/5.2.0` with `PHPSESSID` cookies.
- Ports 80 and 8163 serve the same tested public interfaces.
- `/maestro.php` and `/index.php` return HTTP 200; `/` returns a normal HTTP 404.

## Protocol families

### Maestro library API

The discontinued browser controller uses relative `server/*.php` routes. Its `send()` helper uses POST with `application/x-www-form-urlencoded`, even for read operations. Responses include XML and JavaScript callback source that the original controller evaluates.

The client declares `MAXITEMS = 21`. Album and artist pagination advances `startindex` in 21-item steps and uses `totalItems` from the XML root to enable first, previous, next, and last navigation.

Verified read-only calls:

| Endpoint | Request | Observed response |
|---|---|---|
| `/server/getNavitree.php` | POST with empty form body | XML tree; `tree`, `item`, and `userdata` nodes |
| `/server/getSubNavitree.php?type=genre&id=genres` | POST with empty form body | Same XML tree schema; values discarded |
| `/server/getcurrentplaying.php` | POST with empty form body | `inf_showcurrentplaying(...)` JavaScript callback |
| `/server/getItemInformation.php` | POST with current private item ID | `inf_showEditMode(...)` callback; private values discarded |
| `/server/getSearchResult.php` | POST with a generated impossible search token | Empty XML `tree`, HTTP 200 |
| `/server/getCompilationsAndTracks.php` | POST for first album page | XML `tree/item/userdata`; includes `totalItems` pagination metadata |

Statically referenced read surfaces, not yet invoked:

- `getInterpretersByGenreId.php?gid=`
- `getTracks.php?startindex=`
- `getAlphabetJump.php?id=&letter=&startindex=&type=&action=`
- `getItemInformation.php?type=&id=`
- `getBatchItemInformation.php` with form fields `type` and `ids`
- `getArtwork.php`
- `getnewinfo.php?id=`

### Front-panel API

The device interface uses three principal routes:

- `/includes/ajax/a_executeOperation.php?action=...`
- `/includes/ajax/a_getMenu.php?action=...`
- `/backend/menuZapp.php?command=...`

Verified read-only calls:

| Endpoint | Observed response |
|---|---|
| `a_executeOperation.php?action=getLangMaestro` | Translation payload, HTTP 200 |
| `a_getMenu.php?action=musicLibrary` | JSON-like menu data with IDs, actions, hierarchy and scrolling metadata |

The `musicLibrary` menu response contains keys for `menuitems`, `action`, `id`, `parentid`, `id_type`, `isDir`, `menuNr`, `scrollpoint`, `style`, and `title`. Values were not retained because they can expose library organization.

## Polling and state

Static code shows `getStateChange` with an optional `init=true` and a comma-separated `ack` parameter. The UI acknowledges cached state-change identifiers. This endpoint has not been invoked because consuming or acknowledging the device event stream may interfere with another controller.

The Maestro current-playing endpoint is the safer initial now-playing source: it returns a callback containing a track identifier, which can then be passed to the read-only item-information endpoint. During this capture the item-information call returned `inf_showEditMode(...)`, so a richer now-playing field schema still needs to be observed while a normal track is actively playing.

The verified navigation-root and current-playing response bodies were byte-for-byte identical on ports 80 and 8163.

## Risk classification

### Playback operations — do not call during read-only discovery

- `server/player.php?mode=&id=&index=`
- `includes/ajax/a_executeOperation.php?action=controlPlayer&root=playItem&upnpid=&sortCrit=&index=`
- `action=controlPlayer`, `playItem`, `playCD`, `left_skip`, `right_skip`, `setPlaySpeed`
- `action=volumeSet`, `volumeUp`, `volumeDown`, `mute`

### Library mutations — quarantined

- `addToPlaylist.php`, `newPlaylist.php`, `PL_rename.php`
- `deleteItem.php`, `setGenre.php`, `updateGenre.php`, `reorder.php`
- `updateDetailUPNP.php`, `updateCDSObject.php`, `updateMaintree.php`
- `action=deleteTrack`, `playscreenAddToPlaylist`

### System mutations — quarantined

- `action=performFactoryReset`, `rebootSystem`, `setSystemMode`
- CD database update, burn, eject and USB import actions
- Network settings routes
- Upgrade-server selection commands

The `controlPlayer` play route was invoked against the test O4HD and returned `{"err":null,"action":"playItem"}`; the device then reported an advancing `RelativeTimePosition`. Library-mutation and system-mutation routes were not invoked.

## Next safe probes

1. Confirm terminal-page behavior of `getCompilationsAndTracks.php` without retaining titles.
2. Repeat the current-playing information probe while a normal track is actively playing, recording field names and value types only.
3. Determine whether a new PHP session changes navigation or current-playing response formats.
4. Observe—but do not acknowledge—the front-panel state-change protocol in a controlled test with no other controller attached.
