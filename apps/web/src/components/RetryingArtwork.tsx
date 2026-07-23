import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  src: string;
  fallback: ReactNode;
}

const MAX_RETRIES = 2;

/** Retries transient LAN image failures without changing the canonical artwork URL. */
export function RetryingArtwork({ src, fallback, ...props }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(Boolean(src));
  const [exhausted, setExhausted] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(retryTimer.current);
    setAttempt(0);
    setVisible(Boolean(src));
    setExhausted(false);
    return () => window.clearTimeout(retryTimer.current);
  }, [src]);

  function retry() {
    setVisible(false);
    if (attempt >= MAX_RETRIES) {
      setExhausted(true);
      return;
    }
    retryTimer.current = window.setTimeout(() => {
      setAttempt((value) => value + 1);
      setVisible(true);
    }, 600 * (attempt + 1));
  }

  return src && visible && !exhausted
    ? <img key={`${src}:${attempt}`} src={src} {...props} onError={retry} />
    : <>{fallback}</>;
}
