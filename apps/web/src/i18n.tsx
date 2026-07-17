import { createContext, useContext, type ReactNode } from "react";

type TranslationKey = "home" | "library" | "search" | "playlists" | "addMusic" | "lab" | "settings" | "localOnly" | "noCloud" | "connected" | "automatic";

const translations: Record<TranslationKey, string> = { home: "Now Playing", library: "Library", search: "Search", playlists: "Playlists", addMusic: "Add Music", lab: "Lab", settings: "Settings", localOnly: "Local network only", noCloud: "No cloud", connected: "Connected", automatic: "Automatic" };

interface I18nValue { t: (key: TranslationKey) => string }
const I18nContext = createContext<I18nValue | null>(null);
const english: I18nValue = { t: (key) => translations[key] };

export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={english}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}
