import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Locale = "en" | "fr" | "de" | "es";
type TranslationKey = "home" | "library" | "search" | "playlists" | "addMusic" | "lab" | "settings" | "localOnly" | "noCloud" | "connected" | "automatic";

const translations: Record<Locale, Record<TranslationKey, string>> = {
  en: { home: "Now Playing", library: "Library", search: "Search", playlists: "Playlists", addMusic: "Add Music", lab: "Lab", settings: "Settings", localOnly: "Local network only", noCloud: "No cloud", connected: "Connected", automatic: "Automatic" },
  fr: { home: "À l’écoute", library: "Bibliothèque", search: "Rechercher", playlists: "Listes", addMusic: "Ajouter", lab: "Laboratoire", settings: "Réglages", localOnly: "Réseau local uniquement", noCloud: "Sans cloud", connected: "Connecté", automatic: "Automatique" },
  de: { home: "Aktuelle Wiedergabe", library: "Mediathek", search: "Suchen", playlists: "Playlists", addMusic: "Musik hinzufügen", lab: "Labor", settings: "Einstellungen", localOnly: "Nur lokales Netzwerk", noCloud: "Keine Cloud", connected: "Verbunden", automatic: "Automatisch" },
  es: { home: "En reproducción", library: "Biblioteca", search: "Buscar", playlists: "Listas", addMusic: "Añadir música", lab: "Laboratorio", settings: "Ajustes", localOnly: "Solo red local", noCloud: "Sin nube", connected: "Conectado", automatic: "Automático" },
};

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (key: TranslationKey) => string }
const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const stored = localStorage.getItem("olive-remote-locale");
  if (stored === "en" || stored === "fr" || stored === "de" || stored === "es") return stored;
  const browser = navigator.language.slice(0, 2);
  return browser === "fr" || browser === "de" || browser === "es" ? browser : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale: (next) => { localStorage.setItem("olive-remote-locale", next); updateLocale(next); },
    t: (key) => translations[locale][key],
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}
