import type { OliveModelCapabilities } from "@olive-remote-lab/olive-client";

export function QueueView({ model }: { model: OliveModelCapabilities | null }) {
  return <section className="module-stack">
    <div className="card capability-hero"><span className="step">SAFE DEFAULT</span><h2>Playback queue</h2><p>The observed controller code contains an internal event queue, but no verified endpoint that reads the server’s playback queue. Olive Remote will not substitute that internal object or consume the device’s state-change stream.</p></div>
    <div className="card evidence-panel"><div><span className="evidence-badge unknown">NOT EXPOSED</span><h3>{model?.displayName ?? "Selected device"}</h3><p>Queue viewing and reordering are disabled. They will activate per model only after a response contract is captured without acknowledging or altering device state.</p></div><ul><li>No fabricated queue data</li><li>No event acknowledgements</li><li>No destructive write probes</li></ul></div>
  </section>;
}
