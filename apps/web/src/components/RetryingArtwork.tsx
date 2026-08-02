import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { resolveArtworkSource } from "../artwork";
import { isNativeApp } from "../nativeApi";

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  src: string;
  fallback: ReactNode;
  onExhausted?: () => void;
}

const MAX_RETRIES = 2;

/** Retries transient LAN image failures without changing the canonical artwork URL. */
export function RetryingArtwork({ src, fallback, onExhausted, ...props }: Props) {
  const nativeSource = isNativeApp && src.startsWith("http://");
  const [resolvedSource, setResolvedSource] = useState(nativeSource ? "" : src);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(Boolean(src) && !nativeSource);
  const [exhausted, setExhausted] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const exhaustedCallback = useRef(onExhausted);
  exhaustedCallback.current = onExhausted;

  useEffect(() => {
    let active = true;
    window.clearTimeout(retryTimer.current);
    setResolvedSource(nativeSource ? "" : src);
    setAttempt(0);
    setVisible(Boolean(src) && !nativeSource);
    setExhausted(false);
    if (src) {
      void resolveArtworkSource(src).then((resolved) => {
        if (!active) return;
        setResolvedSource(resolved);
        setVisible(Boolean(resolved));
        if (!resolved) {
          setExhausted(true);
          exhaustedCallback.current?.();
        }
      });
    }
    return () => {
      active = false;
      window.clearTimeout(retryTimer.current);
    };
  }, [nativeSource, src]);

  function retry() {
    setVisible(false);
    if (attempt >= MAX_RETRIES) {
      setExhausted(true);
      exhaustedCallback.current?.();
      return;
    }
    retryTimer.current = window.setTimeout(() => {
      setAttempt((value) => value + 1);
      setVisible(true);
    }, 600 * (attempt + 1));
  }

  return resolvedSource && visible && !exhausted
    ? <img key={`${resolvedSource}:${attempt}`} src={resolvedSource} {...props} onError={retry} />
    : <>{fallback}</>;
}
