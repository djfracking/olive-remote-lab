export type ProtocolEvidence = "verified-response" | "static-reference";
export type ProtocolRisk = "read-only" | "playback" | "library-mutation" | "system-mutation";
export type ProtocolFamily = "maestro" | "front-panel";

/** Page size declared by the observed Maestro client implementation. */
export const OLIVE_4HD_MAESTRO_PAGE_SIZE = 21;

export interface ObservedProtocolSurface {
  readonly id: string;
  readonly family: ProtocolFamily;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly evidence: ProtocolEvidence;
  readonly risk: ProtocolRisk;
  readonly responseShape?: "html" | "xml" | "javascript-callback" | "json-like";
  readonly notes: string;
}

/**
 * Observed on a real 4HD interface. Entries describe evidence only; they do not
 * authorize execution. Production commands must be added separately after a
 * response contract and firmware compatibility are verified.
 */
export const OLIVE_4HD_OBSERVED_SURFACES = [
  {
    id: "maestro.navigation-root",
    family: "maestro",
    method: "POST",
    path: "/server/getNavitree.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "xml",
    notes: "Empty form body returned a tree containing item and userdata nodes.",
  },
  {
    id: "maestro.sub-navigation",
    family: "maestro",
    method: "POST",
    path: "/server/getSubNavitree.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "xml",
    notes: "Genre container probe returned the same tree, item and userdata schema as the root navigation response.",
  },
  {
    id: "maestro.current-playing",
    family: "maestro",
    method: "POST",
    path: "/server/getcurrentplaying.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "javascript-callback",
    notes: "Empty form body returned an inf_showcurrentplaying callback with a private item identifier.",
  },
  {
    id: "maestro.item-information",
    family: "maestro",
    method: "POST",
    path: "/server/getItemInformation.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "javascript-callback",
    notes: "Current private item identifier produced an inf_showEditMode callback; values were discarded.",
  },
  {
    id: "front-panel.language-maestro",
    family: "front-panel",
    method: "GET",
    path: "/includes/ajax/a_executeOperation.php?action=getLangMaestro",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "html",
    notes: "Returned a translation payload; no state change observed.",
  },
  {
    id: "front-panel.music-library-menu",
    family: "front-panel",
    method: "GET",
    path: "/includes/ajax/a_getMenu.php?action=musicLibrary",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "json-like",
    notes: "Returned menuitems with action, id, parent, directory, title, style and scroll metadata.",
  },
  {
    id: "maestro.library-children",
    family: "maestro",
    method: "POST",
    path: "/server/getCompilationsAndTracks.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "xml",
    notes: "A first album page returned tree, item and userdata nodes plus totalItems pagination metadata; private values were discarded.",
  },
  {
    id: "maestro.search",
    family: "maestro",
    method: "POST",
    path: "/server/getSearchResult.php",
    evidence: "verified-response",
    risk: "read-only",
    responseShape: "xml",
    notes: "A deliberately impossible search token returned an empty XML tree without exposing library content.",
  },
  {
    id: "maestro.player",
    family: "maestro",
    method: "POST",
    path: "/server/player.php",
    evidence: "verified-response",
    risk: "playback",
    notes: "Original Maestro playback route verified on an O4HD with mode=play, an item id and optional index. Never invoked during discovery.",
  },
  {
    id: "maestro.delete-item",
    family: "maestro",
    method: "POST",
    path: "/server/deleteItem.php",
    evidence: "static-reference",
    risk: "library-mutation",
    notes: "Destructive endpoint. Quarantined and not invoked.",
  },
  {
    id: "front-panel.factory-reset",
    family: "front-panel",
    method: "GET",
    path: "/includes/ajax/a_executeOperation.php?action=performFactoryReset",
    evidence: "static-reference",
    risk: "system-mutation",
    notes: "Destructive action. Quarantined and not invoked.",
  },
  {
    id: "front-panel.reboot",
    family: "front-panel",
    method: "GET",
    path: "/includes/ajax/a_executeOperation.php?action=rebootSystem",
    evidence: "static-reference",
    risk: "system-mutation",
    notes: "System action. Quarantined and not invoked.",
  },
] as const satisfies readonly ObservedProtocolSurface[];

export function isVerifiedReadOnlySurface(surface: ObservedProtocolSurface): boolean {
  return surface.evidence === "verified-response" && surface.risk === "read-only";
}
