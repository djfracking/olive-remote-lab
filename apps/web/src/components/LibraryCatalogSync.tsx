import { useEffect, useState } from "react";
import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { isDemoTarget } from "../demoOlive";
import { syncLibraryCatalog, type LibraryCatalogProgress } from "../libraryCatalog";

interface LibraryCatalogSyncProps {
  connected: boolean;
  target: OliveDeviceTarget;
}

export function LibraryCatalogSync({ connected, target }: LibraryCatalogSyncProps) {
  const [progress, setProgress] = useState<LibraryCatalogProgress | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (!connected || !target.host || isDemoTarget(target)) {
      setProgress(null);
      return () => { active = false; };
    }
    const controller = new AbortController();
    const run = () => { void syncLibraryCatalog(target, (next) => { if (active) setProgress(next); }, false, controller.signal).catch(() => undefined); };
    run();
    const refresh = window.setInterval(run, 60 * 60 * 1_000);
    return () => { active = false; controller.abort(); window.clearInterval(refresh); };
  }, [connected, target.host, target.port, retry]);

  if (!progress || progress.phase === "complete") return null;
  const percent = progress.scopeTotal && progress.scopeTotal > 0
    ? Math.min(100, Math.round(progress.scopeItems / progress.scopeTotal * 100))
    : null;
  const scopeLabel = progress.scope ? progress.scope.charAt(0).toUpperCase() + progress.scope.slice(1) : "Library";

  return <div className={`catalog-sync ${progress.phase}`} role="status" aria-live="polite">
    <div><strong>{progress.phase === "error" ? "Library sync paused" : "Preparing your library"}</strong><span>{progress.phase === "error" ? progress.message : `${scopeLabel} · ${progress.scopeItems.toLocaleString()}${progress.scopeTotal ? ` of ${progress.scopeTotal.toLocaleString()}` : ""}`}</span></div>
    {progress.phase === "syncing" && <i><b style={{ width: percent === null ? "28%" : `${percent}%` }} /></i>}
    {progress.phase === "error" && <button className="secondary" onClick={() => setRetry((value) => value + 1)}>Resume</button>}
    <small>{progress.itemCount.toLocaleString()} items available for instant search</small>
  </div>;
}
