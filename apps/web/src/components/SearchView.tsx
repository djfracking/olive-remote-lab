import { useState } from "react";
import type { LibrarySearchScope, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";

interface SearchViewProps { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void }

export function SearchView({ connected, target, onStatus }: SearchViewProps) {
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<LibrarySearchScope>("albums");
  const [results, setResults] = useState<MaestroTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");

  async function search() {
    if (!connected || !term.trim()) return;
    setLoading(true); setError("");
    try {
      const response = await appFetch("/api/library/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, term, scope }) });
      const data = await response.json() as MaestroTree & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Search failed.");
      setResults(data); onStatus(`${data.items.length} ${scope} matches`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Search failed."); }
    finally { setLoading(false); }
  }

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const playbackIndex = item.userData.playbackIndex ? Number(item.userData.playbackIndex) : undefined;
      const command = { action: "play" as const, itemId: item.id, ...(playbackIndex !== undefined ? { index: playbackIndex } : {}) };
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Playback failed.");
      onStatus(`Playing ${item.title}`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  if (!connected) return <section className="card module-empty"><h2>Connect a server</h2><p>Choose a local device before searching its library.</p></section>;

  return <section className="module-stack">
    <div className="card search-hero"><span className="step">LIVE</span><h2>Search the server</h2><p>Queries go directly to the selected device and are not retained in diagnostic exports.</p><form onSubmit={(event) => { event.preventDefault(); void search(); }}><select value={scope} onChange={(event) => setScope(event.target.value as LibrarySearchScope)} aria-label="Search scope"><option value="albums">Albums</option><option value="artists">Artists</option><option value="genres">Genres</option><option value="tracks">Tracks</option><option value="playlists">Playlists</option></select><input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search your music library" aria-label="Search text" /><button disabled={loading || !term.trim()}>{loading ? "Searching…" : "Search"}</button></form></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card search-results"><div className="section-heading"><div><span className="step">RESULTS</span><h2>{results ? `${results.items.length} matches` : "Ready"}</h2></div></div>{results ? results.items.length ? <div className="library-grid">{results.items.map((item) => <button key={item.id} onClick={() => scope === "tracks" ? void play(item) : undefined}><span className="library-icon">{scope === "tracks" ? "▶" : "♪"}</span><span><strong>{item.title || "Untitled"}</strong><small>{scope === "tracks" ? (playingId === item.id ? "Starting…" : "Play track") : scope}</small></span><i>›</i></button>)}</div> : <div className="empty">No matches found.</div> : <div className="empty">Choose a category and enter a search term.</div>}</div>
  </section>;
}
