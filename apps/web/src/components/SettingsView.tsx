import { OLIVE_MODEL_CAPABILITIES, type CapabilityEvidence, type OliveDeviceTarget, type OliveModelCapabilities } from "@olive-remote-lab/olive-client";
import { useI18n, type Locale } from "../i18n";

const label = (value: CapabilityEvidence) => value === "verified" ? "Verified" : value === "shared-firmware-marker" ? "Shared marker" : "Needs device";

export function SettingsView({ target, model, onOpenLab }: { target: OliveDeviceTarget; model: OliveModelCapabilities | null; onOpenLab: () => void }) {
  const { locale, setLocale } = useI18n();
  return <section className="module-stack">
    <div className="card settings-summary"><span className="step">LOCAL PROFILE</span><h2>{model?.displayName ?? "Unconfirmed model"}</h2><p>{target.host ? `${target.host}:${target.port}` : "No device selected"} · {model?.protocolFamily ?? "unknown"} protocol family · no cloud</p>{model && <div className="capability-row"><span>Library<strong>{label(model.maestroLibrary)}</strong></span><span>Front panel API<strong>{label(model.frontPanelApi)}</strong></span><span>Playback<strong>{label(model.playbackControl)}</strong></span></div>}</div>
    <div className="settings-grid">
      <div className="card preference-card"><span className="step">LANGUAGE</span><h3>Interface language</h3><p>The everyday navigation is available in English, French, German and Spanish. The protocol lab remains in technical English.</p><select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label="Interface language"><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option></select></div>
      <div className="card preference-card"><span className="step">OPTIONAL SERVICES</span><h3>Apple Music and Spotify</h3><p>The local Olive remote needs no account. Apple Music and Spotify would be separate opt-in players requiring internet access, provider authorization and subscriptions; neither can stream directly into legacy Olive firmware without a supported receiver path.</p><div className="service-status"><span>Apple Music <strong>Not configured</strong></span><span>Spotify <strong>Not configured</strong></span></div></div>
    </div>
    <div className="card lab-access"><div><span className="step">ADVANCED</span><h3>Protocol Lab</h3><p>Discovery details, endpoint tests, arbitrary requests and redacted diagnostics are kept out of the everyday remote.</p></div><button className="secondary" onClick={onOpenLab}>Open Protocol Lab</button></div>
    <div className="card compatibility-card"><div className="section-heading"><div><span className="step">FAMILY</span><h2>Model compatibility registry</h2></div><span className="tag">EVIDENCE GATED</span></div><p>A listed model is a research target, not a claim of full compatibility. Only the connected O4HD has been verified so far.</p><div className="compatibility-table">{OLIVE_MODEL_CAPABILITIES.filter((item) => item.model !== "unknown").map((item) => <article className={item.model === model?.model ? "selected" : ""} key={item.model}><div><strong>{item.displayName}</strong><small>{item.role} · {item.protocolFamily}</small></div><span className={`evidence-badge ${item.maestroLibrary}`}>{label(item.maestroLibrary)}</span><p>{item.notes}</p></article>)}</div></div>
  </section>;
}
