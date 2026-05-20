// SchedulePostingModal — producer-side modal that turns approved
// videos into a Zernio-pushed posting schedule. Pattern follows the
// ShareWithClientModal in Deliveries.jsx (lifted state, batchId
// minted once per modal open for idempotency, single async submit).
//
// Triggered from the "All videos approved — Schedule social posting"
// banner in Deliveries.jsx, only when:
//   1. Every video in the delivery is Approved.
//   2. delivery.postingOwner === "viewix" (default).
//   3. delivery.createdAt > launchDate (new-deliveries-only migration).
//   4. Every video has zernioMediaUrl set (asset transfer complete).
//
// Server (api/schedule-posting-batch.js) is the final authority for
// postAt — this modal computes a preview client-side for display, but
// the server recomputes from preferences and the displayed times may
// shift by seconds if the client's clock drifts. That's fine; the
// modal closes immediately on success and the producer sees the
// authoritative schedule in the Posting Schedule tab of the client
// portal (Phase 5) + the Deliveries list.

import { useState, useMemo, useEffect } from "react";
import { BTN } from "../config";
import { authFetch } from "../firebase";

// Day labels for the days-of-week checkboxes. Order matters for the
// "default Mon/Wed/Fri" pre-tick — we render in Mon-first order to
// match how producers think about a working week.
const DAY_LIST = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

// Same shape as ShareWithClientModal's batchId — alnum + hyphen,
// stable per modal open, regenerates on close + reopen.
function makeBatchId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

// Convert "YYYY-MM-DD" to a Date at noon Sydney for next-weekday math.
// Using noon avoids DST edge cases on the day the offset flips.
function nextDateOnOrAfter(startStr, dayKey) {
  if (!startStr || !dayKey) return startStr;
  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[dayKey];
  const d = new Date(`${startStr}T12:00:00`);
  let safety = 0;
  while (d.getDay() !== dayIdx && safety++ < 14) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function pad2(n) { return String(n).padStart(2, "0"); }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function SchedulePostingModal({
  delivery,
  accountId,
  accountPlatforms,        // { instagram: {enabled,...}, tiktok: {enabled,...}, ... }
  clientPreferences,       // /deliveries/{id}/postingPreferences if client set them
  defaultVideosPerWeek,    // tier-derived
  onClose,
  onSent,
}) {
  const videos = useMemo(
    () => (Array.isArray(delivery?.videos) ? delivery.videos.filter(Boolean) : []),
    [delivery]
  );
  const enabledPlatforms = useMemo(() => {
    if (!accountPlatforms) return ["instagram", "tiktok", "youtube", "linkedin"];
    return Object.entries(accountPlatforms)
      .filter(([, v]) => v && v.enabled)
      .map(([k]) => k);
  }, [accountPlatforms]);

  // ─── Form state ─────────────────────────────────────────────────
  // Precedence: client preference (if set) → tier default → producer.
  // Pre-fill once on mount; producer can change anything.
  const [days, setDays] = useState(() => {
    if (clientPreferences?.daysOfWeek?.length) return clientPreferences.daysOfWeek;
    return ["mon", "wed", "fri"];
  });
  const [videosPerWeek, setVideosPerWeek] = useState(() => {
    if (typeof clientPreferences?.videosPerWeek === "number") return clientPreferences.videosPerWeek;
    return defaultVideosPerWeek || 1;
  });
  const [startDate, setStartDate] = useState(() => {
    const today = todayIso();
    const firstDay = (clientPreferences?.daysOfWeek?.[0]) || "mon";
    return nextDateOnOrAfter(today, firstDay);
  });
  const [defaultTime, setDefaultTime] = useState(() => {
    return clientPreferences?.times?.default || "09:00";
  });

  // Per-video config: caption + platforms + trial-reel.
  const [perVideo, setPerVideo] = useState(() => {
    const init = {};
    for (const v of videos) {
      init[v.id] = {
        caption: v.caption || "",
        platforms: enabledPlatforms.slice(),     // default = all in-scope
        trialReel: false,
        videoIdx: videos.indexOf(v),
        videoId: v.videoId || v.id,
      };
    }
    return init;
  });
  const tikTokInBatch = useMemo(
    () => Object.values(perVideo).some(pv => pv.platforms?.includes("tiktok")),
    [perVideo]
  );
  // TikTok compliance — per-delivery (single section, applied to all
  // TikTok-targeting items). Defaults per the plan: commercial=true,
  // branded=false, music=must-tick, privacy=PUBLIC_TO_EVERYONE.
  const [tikTokCompliance, setTikTokCompliance] = useState({
    discloseCommercialContent: true,
    discloseBrandedContent: false,
    musicConsent: false,
    privacyLevel: "PUBLIC_TO_EVERYONE",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [batchId] = useState(makeBatchId);

  // Re-snap startDate when the producer changes daysOfWeek so the
  // start always lands on a chosen day.
  useEffect(() => {
    if (!days.length) return;
    setStartDate(prev => nextDateOnOrAfter(prev || todayIso(), days[0]));
  }, [days]);

  const toggleDay = (k) => setDays(prev =>
    prev.includes(k) ? prev.filter(d => d !== k) : [...prev, k].sort((a, b) =>
      DAY_LIST.findIndex(x => x.key === a) - DAY_LIST.findIndex(x => x.key === b)
    )
  );

  const setVideoField = (vid, patch) => setPerVideo(prev => ({
    ...prev,
    [vid]: { ...prev[vid], ...patch },
  }));

  const toggleVideoPlatform = (vid, platform) => {
    setVideoField(vid, {
      platforms: perVideo[vid].platforms.includes(platform)
        ? perVideo[vid].platforms.filter(p => p !== platform)
        : [...perVideo[vid].platforms, platform],
    });
  };

  // Gate the submit button:
  //  - at least one video selected to post to (at least one platform)
  //  - musicConsent ticked if TikTok is in any item's mix (TikTok rule)
  const canSubmit = useMemo(() => {
    const anyPlatform = Object.values(perVideo).some(pv => pv.platforms.length > 0);
    if (!anyPlatform) return false;
    if (tikTokInBatch && !tikTokCompliance.musicConsent) return false;
    if (!days.length) return false;
    if (!videosPerWeek || videosPerWeek < 1) return false;
    return true;
  }, [perVideo, tikTokInBatch, tikTokCompliance.musicConsent, days, videosPerWeek]);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    const items = Object.values(perVideo)
      .filter(pv => pv.platforms.length > 0)
      .map(pv => ({
        videoIdx: pv.videoIdx,
        caption: pv.caption,
        platforms: pv.platforms,
        trialReel: !!pv.trialReel,
        tikTokCompliance: pv.platforms.includes("tiktok") ? tikTokCompliance : null,
      }));
    try {
      const resp = await authFetch("/api/schedule-posting-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId,
          deliveryId: delivery.id,
          accountId,
          preferences: {
            daysOfWeek: days,
            videosPerWeek,
            times: { default: defaultTime },
            startDate,
          },
          items,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(json.detail || json.error || `HTTP ${resp.status}`);
        setSubmitting(false);
        return;
      }
      onSent?.({ scheduleId: json.scheduleId, idempotent: !!json.idempotent });
    } catch (e) {
      setError(`Network error: ${e.message}`);
      setSubmitting(false);
    }
  };

  const inputSt = {
    padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none",
  };
  const labelSt = {
    fontSize: 10, fontWeight: 700, color: "var(--muted)",
    textTransform: "uppercase", letterSpacing: "0.04em",
    marginBottom: 6, display: "block",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Schedule social posting"
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div style={{
        maxWidth: 720, width: "100%", maxHeight: "92vh", overflow: "auto",
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: 12, padding: 24,
        boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
      }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
            Schedule social posting
          </h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {delivery.clientName || "(no client name)"} · {delivery.projectName || "(no project name)"}
            {clientPreferences?.source === "client" && (
              <span style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "#10B981", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
                Pre-filled from client
              </span>
            )}
          </div>
        </div>

        {/* Cadence row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label style={labelSt}>Posting days</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DAY_LIST.map(d => {
                const on = days.includes(d.key);
                return (
                  <button
                    key={d.key} type="button"
                    onClick={() => toggleDay(d.key)}
                    style={{
                      ...BTN,
                      padding: "6px 12px",
                      background: on ? "var(--accent)" : "transparent",
                      color: on ? "white" : "var(--fg)",
                      border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                      fontSize: 12, fontWeight: 600,
                    }}
                  >{d.label}</button>
                );
              })}
            </div>
          </div>
          <div>
            <label style={labelSt}>Videos per week (max per Mon-Sun)</label>
            <input
              type="number" min="1" max="7"
              value={videosPerWeek}
              onChange={e => setVideosPerWeek(Math.max(1, Math.min(7, Number(e.target.value) || 1)))}
              style={{ ...inputSt, width: 80 }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label style={labelSt}>Start date (Sydney)</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputSt, width: "100%" }} />
          </div>
          <div>
            <label style={labelSt}>Time of day (Sydney)</label>
            <input type="time" value={defaultTime} onChange={e => setDefaultTime(e.target.value)} style={{ ...inputSt, width: "100%" }} />
          </div>
        </div>

        {/* Per-video rows */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ ...labelSt, marginBottom: 8 }}>Videos to schedule ({videos.length})</label>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {videos.map((v) => {
              const pv = perVideo[v.id];
              if (!pv) return null;
              return (
                <div key={v.id} style={{ padding: 12, borderBottom: "1px solid var(--border-light)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 8 }}>
                    {v.name || "(unnamed video)"}
                  </div>
                  <textarea
                    value={pv.caption}
                    onChange={e => setVideoField(v.id, { caption: e.target.value })}
                    placeholder="Caption (snapshotted from pre-prod at approval — edit if needed)"
                    rows={2}
                    style={{ ...inputSt, width: "100%", fontFamily: "inherit", resize: "vertical", marginBottom: 8 }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {enabledPlatforms.map(p => {
                      const on = pv.platforms.includes(p);
                      return (
                        <button
                          key={p} type="button"
                          onClick={() => toggleVideoPlatform(v.id, p)}
                          style={{
                            ...BTN,
                            padding: "4px 10px",
                            background: on ? "rgba(16,185,129,0.15)" : "transparent",
                            color: on ? "#10B981" : "var(--muted)",
                            border: `1px solid ${on ? "#10B981" : "var(--border)"}`,
                            fontSize: 11, fontWeight: 700,
                            textTransform: "capitalize",
                          }}
                        >{p}</button>
                      );
                    })}
                    {pv.platforms.includes("instagram") && (
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 12, fontSize: 11, color: "var(--muted)", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={pv.trialReel}
                          onChange={e => setVideoField(v.id, { trialReel: e.target.checked })}
                          style={{ accentColor: "var(--accent)" }}
                        /> IG Trial Reel
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* TikTok compliance */}
        {tikTokInBatch && (
          <div style={{ marginBottom: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              TikTok compliance (per Zernio support — TikTok requires these before posting)
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <label style={{ fontSize: 12, color: "var(--fg)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox"
                  checked={tikTokCompliance.discloseCommercialContent}
                  onChange={e => setTikTokCompliance(p => ({ ...p, discloseCommercialContent: e.target.checked }))}
                  style={{ accentColor: "var(--accent)" }}
                />
                Commercial content disclosure (default ON — Viewix client work is paid/commercial)
              </label>
              <label style={{ fontSize: 12, color: "var(--fg)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox"
                  checked={tikTokCompliance.discloseBrandedContent}
                  onChange={e => setTikTokCompliance(p => ({ ...p, discloseBrandedContent: e.target.checked }))}
                  style={{ accentColor: "var(--accent)" }}
                />
                Branded content / brand partnership (tick if applicable)
              </label>
              <label style={{ fontSize: 12, color: "var(--fg)", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox"
                  checked={tikTokCompliance.musicConsent}
                  onChange={e => setTikTokCompliance(p => ({ ...p, musicConsent: e.target.checked }))}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span style={{ fontWeight: 700 }}>Music usage license confirmed (REQUIRED)</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Privacy level:</span>
                <select
                  value={tikTokCompliance.privacyLevel}
                  onChange={e => setTikTokCompliance(p => ({ ...p, privacyLevel: e.target.value }))}
                  style={{ ...inputSt, fontSize: 12, padding: "4px 8px" }}
                >
                  <option value="PUBLIC_TO_EVERYONE">PUBLIC_TO_EVERYONE</option>
                  <option value="MUTUAL_FOLLOW_FRIENDS">MUTUAL_FOLLOW_FRIENDS</option>
                  <option value="SELF_ONLY">SELF_ONLY</option>
                </select>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>(Zernio creator_info will narrow these; default kept if unrestricted.)</span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            marginBottom: 12, padding: "10px 12px",
            background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)",
            borderRadius: 6, color: "#EF4444", fontSize: 12, lineHeight: 1.45,
          }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            style={{ ...BTN, background: "transparent", color: "var(--fg)", border: "1px solid var(--border)" }}
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            style={{
              ...BTN,
              background: (canSubmit && !submitting) ? "#10B981" : "#374151",
              color: "white",
              opacity: (canSubmit && !submitting) ? 1 : 0.6,
              cursor: (canSubmit && !submitting) ? "pointer" : "not-allowed",
            }}
          >{submitting ? "Scheduling…" : "Schedule"}</button>
        </div>
      </div>
    </div>
  );
}
