// WhatsWorking — wrapper zone for the patterns that earn this
// client over-performance.
//
// Phase 6 ships Format Playbook. Phase 8 (stretch) adds the Hook
// Analyzer to this zone if scope allows — the data model is ready
// (videos carry hookType in classifications) so adding it is wiring,
// not redesign.

import { FormatPlaybook } from "./FormatPlaybook";

export function WhatsWorking({ playbook }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)" }}>
          What's working
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
          The patterns this client earns the most lift from. Hook analyzer
          lands in Phase 8 if scope allows; the data slot is reserved.
        </div>
      </div>
      <FormatPlaybook playbook={playbook} />
    </div>
  );
}
