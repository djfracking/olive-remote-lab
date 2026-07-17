import type { ReactNode, SVGProps } from "react";

type IconName =
  | "home" | "library" | "search" | "playlists" | "add" | "lab" | "settings"
  | "previous" | "next" | "play" | "pause" | "playPause" | "stop" | "expand" | "collapse" | "speaker" | "device";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 11 9-8 9 8"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-7h5v7"/></>,
  library: <><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17 5 4 14"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m16.2 16.2 4.3 4.3"/></>,
  playlists: <><path d="M4 6h10M4 11h10M4 16h7"/><path d="M17 9v9.5a2.5 2.5 0 1 1-2-2.45"/><path d="m17 9 4-1v3l-4 1"/></>,
  add: <><path d="M12 4v16M4 12h16"/></>,
  lab: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.75 3h10.5A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.37.33.7.6 1 .27.27.63.42 1 .4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z"/></>,
  previous: <><path d="M6 5v14"/><path d="m18 6-9 6 9 6Z" fill="currentColor" stroke="none"/></>,
  next: <><path d="M18 5v14"/><path d="m6 6 9 6-9 6Z" fill="currentColor" stroke="none"/></>,
  play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>,
  pause: <><path d="M8 6v12M16 6v12" strokeWidth="3"/></>,
  playPause: <><path d="m7 5 7 7-7 7Z" fill="currentColor" stroke="none"/><path d="M17 6v12M21 6v12"/></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>,
  expand: <path d="m7 14 5-5 5 5"/>,
  collapse: <path d="m7 10 5 5 5-5"/>,
  speaker: <><path d="M5 10v4h4l5 4V6l-5 4Z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/></>,
  device: <><rect x="4" y="5" width="16" height="12" rx="2"/><path d="M9 21h6M12 17v4"/></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>;
}
