import { useEffect, useState } from "react";
import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { isDemoTarget } from "../demoOlive";
import { syncLibraryCatalog, type LibraryCatalogProgress } from "../libraryCatalog";
import { deviceCacheNamespace, deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";

interface LibraryCatalogSyncProps {
  connected: boolean;
  target: OliveDeviceTarget;
}

export function LibraryCatalogSync({ connected, target }: LibraryCatalogSyncProps) {
  const [progress, setProgress] = useState<LibraryCatalogProgress | null>(null);
  const [retry, setRetry] = useState(0);
  const targetNamespace = deviceCacheNamespace(target as StableOliveTarget);
  const endpointSignature = deviceRequestKey(target as StableOliveTarget);

  useEffect(() => {
    let active = true;
    if (!connected || !target.host || isDemoTarget(target)) {
      setProgress(null);
      return () => { active = false; };
    }
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let failureCount = 0;
    const run = () => {
      void syncLibraryCatalog(
        target,
        (next) => { if (active) setProgress(next); },
        false,
        controller.signal,
      ).then(() => {
        failureCount = 0;
      }).catch(() => {
        if (!active || controller.signal.aborted) return;
        failureCount += 1;
        const delay = Math.min(30_000, 2_000 * 2 ** Math.min(failureCount - 1, 4));
        retryTimer = window.setTimeout(run, delay);
      });
    };
    run();
    const refresh = window.setInterval(run, 60 * 60 * 1_000);
    return () => {
      active = false;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.clearInterval(refresh);
    };
  }, [connected, targetNamespace, endpointSignature, retry]);

  if (!progress || progress.phase === "complete") return null;
  const percent = progress.scopeTotal && progress.scopeTotal > 0
    ? Math.min(100, Math.round(progress.scopeItems / progress.scopeTotal * 100))
    : null;
  const scopeLabel = progress.scope ? progress.scope.charAt(0).toUpperCase() + progress.scope.slice(1) : "Library";

  return <div className={`catalog-sync ${progress.phase}`} role="status" aria-live="polite">
    <div><strong>{progress.phase === "error" ? "Library download paused" : "Downloading your search index"}</strong><span>{progress.phase === "error" ? progress.message : `${scopeLabel} · ${progress.scopeItems.toLocaleString()}${progress.scopeTotal ? ` of ${progress.scopeTotal.toLocaleString()}` : ""} indexed`}</span></div>
    {progress.phase === "syncing" && <i><b style={{ width: percent === null ? "28%" : `${percent}%` }} /></i>}
    {progress.phase === "error" && <button className="secondary" onClick={() => setRetry((value) => value + 1)}>Resume</button>}
    <small>{progress.itemCount.toLocaleString()} items indexed and ready for instant search</small>
  </div>;
}
