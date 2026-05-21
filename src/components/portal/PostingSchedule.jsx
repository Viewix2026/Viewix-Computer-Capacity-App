// PostingSchedule — read-only tab in ProjectView showing upcoming +
// recent scheduled social posts for a delivery. Reschedule / cancel
// from the client portal is deferred to a later phase; today we just
// show the schedule.

import { useEffect, useState } from "react";
import { Pill, Icon, Label } from "./ui";

const PLATFORM_LABEL = {
  instagram: "IG", tiktok: "TikTok", youtube: "YT", linkedin: "LinkedIn", facebook: "FB",
};

const STATUS_TONE = {
  pending:   { tone: "blue",   label: "Scheduled" },
  posted:    { tone: "green",  label: "Posted" },
  failed:    { tone: "red",    label: "Failed" },
  cancelled: { tone: "muted",  label: "Cancelled" },
};

function fmtSydney(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      day: "numeric", month: "short", weekday: "short",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function PostingSchedule({ projectShortId, authFetch, narrow }) {
  const [state, setState] = useState({ loading: true, items: [], error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/client/posting-schedule?projectId=${encodeURIComponent(projectShortId)}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setState({ loading: false, items: [], error: j.error || `Error ${r.status}` }); return; }
        setState({ loading: false, items: j.items || [], error: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, items: [], error: e.message || "Network error" });
      }
    })();
    return () => { cancelled = true; };
  }, [projectShortId, authFetch]);

  if (state.loading) {
    return <div style={{ padding: 60, textAlign: "center", color: "var(--text-3)" }}>Loading your schedule…</div>;
  }
  if (state.error) {
    return (
      <div style={{ padding: narrow ? "20px 16px" : "32px 40px" }}>
        <div style={{ padding: 16, borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "var(--danger)", fontSize: 13 }}>
          {state.error}
        </div>
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <div style={{ padding: narrow ? "40px 20px" : "64px 40px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", color: "var(--text-3)" }}><Icon.cal /></div>
        <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "var(--heading)" }}>No posts scheduled yet</h3>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
          Once every video in this delivery is approved, your account manager will line them up across your channels. They&apos;ll appear here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: narrow ? "20px 16px 60px" : "32px 32px 80px" }}>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--heading)" }}>Posting schedule</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-3)" }}>
            All times in Sydney. Want to change something? Reply to your account manager — we&apos;ll re-pace it.
          </p>
        </div>
        <Label>{state.items.length} item{state.items.length === 1 ? "" : "s"}</Label>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {state.items.map((it, i) => {
          const tone = STATUS_TONE[it.status] || STATUS_TONE.pending;
          return (
            <div key={i} style={{
              padding: "12px 16px", borderRadius: 10, border: "1px solid var(--line)",
              background: "var(--surface)",
              display: "grid", gridTemplateColumns: narrow ? "1fr" : "auto 1fr auto", gap: 12, alignItems: "center",
            }}>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 2 }}>{fmtSydney(it.postAt)}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.videoName || "(unnamed)"}</div>
                {it.caption && (
                  <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, lineHeight: 1.45, maxHeight: 36, overflow: "hidden" }}>{it.caption.slice(0, 140)}{it.caption.length > 140 ? "…" : ""}</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {it.platforms.map(p => (
                  <span key={p} style={{ padding: "3px 8px", borderRadius: 4, background: "var(--bg-2)", fontSize: 11, fontWeight: 600, color: "var(--text-2)" }}>{PLATFORM_LABEL[p] || p}</span>
                ))}
                {it.trialReel && (
                  <span style={{ padding: "3px 8px", borderRadius: 4, background: "rgba(248,119,0,0.12)", fontSize: 11, fontWeight: 600, color: "var(--orange-fg, #F87700)" }}>Trial Reel</span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Pill tone={tone.tone}>{tone.label}</Pill>
                {it.permalink && (
                  <a href={it.permalink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--accent)" }}>View →</a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
