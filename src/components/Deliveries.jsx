// Deliveries — founder-only tool for tracking video deliverables per
// project. Tracks per-video Viewix status + client revision rounds, and
// generates shareable client review links. Records are spawned by the
// Attio deal-won webhook or created blank from this list.

import { useState, useEffect } from "react";
import { BTN, TH, NB, VIEWIX_STATUSES, VIEWIX_STATUS_COLORS, CLIENT_REVISION_OPTIONS, CLIENT_REVISION_COLORS } from "../config";
import { newDelivery, newVideo, logoBg, deliveryShareUrl } from "../utils";
import { StatusSelect } from "./UIComponents";
import { fbSet, authFetch } from "../firebase";

export function Deliveries({ deliveries, setDeliveries, accounts, deepLinkDeliveryId }) {
  const [activeDeliveryId, setActiveDeliveryId] = useState(null);
  // Phase A.5 "Share with client" modal state. Lifted to the parent
  // (rather than the detail-view block) so the modal lifecycle stays
  // simple — only one share flow can be active at a time, and the
  // result banner survives a tab pinball back to the same delivery.
  const [shareOpenFor, setShareOpenFor] = useState(null); // delivery id when open
  const [lastShareResult, setLastShareResult] = useState(null); // { deliveryId, state, batchId, videoCount, at }

  // Deep-link receiver — Projects → Delivery linked-record pill drops
  // a hash route like #projects/deliveries/del-1234 which lands here.
  // Auto-opens that delivery once the listener has loaded it. Re-fires
  // when deepLinkDeliveryId changes so producers can pinball between
  // pills without an intermediate Back-to-list.
  useEffect(() => {
    if (!deepLinkDeliveryId) return;
    if (deliveries.find(d => d.id === deepLinkDeliveryId)) {
      setActiveDeliveryId(deepLinkDeliveryId);
    }
  }, [deepLinkDeliveryId, deliveries]);
  const activeDelivery = deliveries.find(d => d.id === activeDeliveryId);

  // Account lookup for logos — trim + partial match handles e.g. "Woolcott St"
  // vs "Woolcott Street Tailors" where the delivery clientName and account
  // companyName don't match exactly.
  const findAcct = (clientName) => {
    if (!clientName) return null;
    const nameLC = clientName.trim().toLowerCase();
    const acctList = Object.values(accounts).filter(Boolean);
    const exact = acctList.find(a => (a.companyName || "").trim().toLowerCase() === nameLC);
    if (exact) return exact;
    const partial = acctList.find(a => {
      const acn = (a.companyName || "").trim().toLowerCase();
      return acn && (acn.includes(nameLC) || nameLC.includes(acn));
    });
    return partial || null;
  };
  const getAcctLogo = (clientName) => findAcct(clientName)?.logoUrl || null;
  const getAcctLogoBg = (clientName) => findAcct(clientName)?.logoBg;

  // ─── Actions ───
  const createBlank = () => {
    const d = newDelivery("New Client", "New Project");
    setDeliveries(p => [...p, d]);
    setActiveDeliveryId(d.id);
  };
  // Producer-side edits go through two paths:
  //   1. Local state update (so the UI reflects the change instantly).
  //   2. Per-field direct fbSet for video-column edits (link / name /
  //      viewixStatus / revision1 / revision2 / notes) via updateVideo
  //      below — writing only the leaf path keeps each keystroke cheap
  //      AND avoids the mid-typing wipe bug we saw when the whole
  //      delivery object got rewritten on every keystroke (Firebase
  //      echoed stale snapshots back through the live listener, which
  //      clobbered keystrokes in flight).
  //   3. Everything else (clientName, logoUrl, notes header, etc.)
  //      rides on the App.jsx debounced bulk-writer, which sets
  //      skipRead so the listener won't race it.
  const updateDelivery = (updated) => {
    setDeliveries(p => p.map(d => d.id === updated.id ? updated : d));
  };
  const deleteDelivery = (id) => {
    // Delete immediately in Firebase — the App-level debounced writer only
    // iterates the local array and writes survivors back; it never knew to
    // null out the deleted path, which let the record resurface after a
    // tab switch once the listener rehydrated state.
    fbSet(`/deliveries/${id}`, null);
    setDeliveries(p => p.filter(d => d.id !== id));
    if (activeDeliveryId === id) setActiveDeliveryId(null);
  };
  const shareUrl = (id) => {
    const d = deliveries.find(x => x.id === id);
    return d ? deliveryShareUrl(d) : `${window.location.origin}?d=${id}`;
  };
  const copyLink = (id) => { navigator.clipboard?.writeText(shareUrl(id)); };

  // ═══════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════
  if (activeDelivery) {
    const d = activeDelivery;
    const dId = d.id;
    // Every handler below uses the functional setDeliveries updater so
    // it reads the LATEST state (not the closure-captured `d`). Without
    // this, two quick edits in a row — paste a link on video A, then
    // paste on video B before React re-renders — would have B's update
    // read the previous d.videos and stamp B's change on top of the
    // pre-A snapshot, reverting A. Same root cause behind the
    // "Viewix status reverts when you flip several quickly" symptom.
    // Each handler also writes the change directly to Firebase via
    // leaf fbSet (instead of relying on the App.jsx bulk-write loop)
    // so /deliveries doesn't depend on a races-prone catch-all rewrite.
    const setD = (patch) => {
      setDeliveries(p => p.map(del => del.id === dId ? { ...del, ...patch } : del));
      Object.entries(patch).forEach(([k, val]) => {
        fbSet(`/deliveries/${dId}/${k}`, val == null ? "" : val);
      });
    };
    const addVideo = () => {
      const nv = newVideo();
      setDeliveries(p => p.map(del => {
        if (del.id !== dId) return del;
        const next = { ...del, videos: [...(del.videos || []), nv] };
        // Write the full videos array — it's the smallest cohesive
        // unit we can stamp here without re-reading state again, and
        // adds aren't a high-frequency operation so a brief race is
        // unlikely. Idempotent: appending the same nv twice would
        // produce duplicates, but addVideo isn't called by anyone
        // else.
        fbSet(`/deliveries/${dId}/videos`, next.videos);
        return next;
      }));
    };
    const updateVideo = (vid, patch) => {
      setDeliveries(p => p.map(del => {
        if (del.id !== dId) return del;
        const idx = (del.videos || []).findIndex(v => v.id === vid);
        if (idx < 0) return del;
        // Write each patched field as a leaf path. Firebase echoes
        // back only the leaf, so it can't clobber neighbouring
        // in-flight keystrokes the root listener is delivering.
        Object.entries(patch).forEach(([k, val]) => {
          fbSet(`/deliveries/${dId}/videos/${idx}/${k}`, val == null ? "" : val);
        });
        const newVideos = del.videos.map(v => v.id === vid ? { ...v, ...patch } : v);
        return { ...del, videos: newVideos };
      }));
    };
    const removeVideo = (vid) => {
      setDeliveries(p => p.map(del => {
        if (del.id !== dId) return del;
        const newVideos = (del.videos || []).filter(v => v.id !== vid);
        fbSet(`/deliveries/${dId}/videos`, newVideos);
        return { ...del, videos: newVideos };
      }));
    };
    const inputSt = { padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", width: "100%" };

    return (
      <>
        <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setActiveDeliveryId(null)} style={{ ...NB, fontSize: 12 }}>&larr; Back</button>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "var(--fg)" }}>{d.projectName || "Untitled project"}</span>
              <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{d.clientName}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Phase A.5 banner — surfaces the result of the most-
                recent "Share with client" send for this delivery.
                Stays visible until the producer navigates away or
                fires another send. */}
            {lastShareResult && lastShareResult.deliveryId === d.id && (
              <span style={{
                fontSize: 11,
                color: lastShareResult.state === "sent" ? "#10B981"
                  : lastShareResult.state === "dryRun" ? "var(--accent)"
                  : "var(--muted)",
                fontWeight: 600,
                marginRight: 4,
              }}>
                {lastShareResult.state === "sent" && `✓ Sent ${lastShareResult.videoCount} ${lastShareResult.videoCount === 1 ? "video" : "videos"} at ${lastShareResult.at}`}
                {lastShareResult.state === "dryRun" && `✓ Dry-run logged at ${lastShareResult.at} (${lastShareResult.videoCount} videos)`}
                {lastShareResult.state === "skipped" && `Already sent (${lastShareResult.batchId.slice(0, 6)}…)`}
                {lastShareResult.state === "noop" && "Kill switch on — send suppressed"}
              </span>
            )}
            <button
              onClick={() => setShareOpenFor(d.id)}
              disabled={!d.videos?.length}
              title={d.videos?.length ? "Share with client" : "Add at least one video first"}
              style={{
                ...BTN,
                background: d.videos?.length ? "#10B981" : "#374151",
                color: "white",
                opacity: d.videos?.length ? 1 : 0.5,
                cursor: d.videos?.length ? "pointer" : "not-allowed",
              }}
            >Share with client</button>
            <button onClick={() => copyLink(d.id)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Copy Share Link</button>
            <button onClick={() => deleteDelivery(d.id)} style={{ ...BTN, background: "#374151", color: "#EF4444" }}>Delete</button>
          </div>
        </div>
        {shareOpenFor === d.id && (
          <ShareWithClientModal
            delivery={d}
            onClose={() => setShareOpenFor(null)}
            onSent={(result) => {
              setLastShareResult({
                deliveryId: d.id,
                state: result.state,
                batchId: result.batchId,
                videoCount: result.videoCount,
                at: new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }),
              });
              setShareOpenFor(null);
            }}
          />
        )}
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>
          {/* Project details */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Client Name</label><input value={d.clientName} onChange={e => setD({ clientName: e.target.value })} style={inputSt} /></div>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Project Name</label><input value={d.projectName} onChange={e => setD({ projectName: e.target.value })} style={inputSt} /></div>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4, display: "block" }}>Client Logo URL</label><input value={d.logoUrl || ""} onChange={e => setD({ logoUrl: e.target.value })} placeholder="https://..." style={inputSt} /></div>
          </div>

          {/* Share link */}
          <div style={{ padding: "12px 16px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div><span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Client Share Link</span><div style={{ fontSize: 12, color: "var(--accent)", marginTop: 2, fontFamily: "'JetBrains Mono',monospace" }}>{shareUrl(d.id)}</div></div>
            <button onClick={() => copyLink(d.id)} style={{ ...BTN, background: "var(--accent)", color: "white" }}>Copy</button>
          </div>

          {/* Videos table */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>Videos ({d.videos.length})</span>
            <button onClick={addVideo} style={{ ...BTN, background: "var(--accent)", color: "white" }}>+ Add Video</button>
          </div>
          {d.videos.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13 }}>No videos yet. Click "+ Add Video" to start.</div>
            </div>
          ) : (
            <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px" }}>Video Name</th>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 200 }}>Link</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 140 }}>Viewix Status</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 120 }}>Rev Round 1</th>
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 120 }}>Rev Round 2</th>
                  <th style={{ ...TH, textAlign: "left", padding: "8px 12px", width: 180 }}>Notes</th>
                  {/* Posted — anyone can tick. Client view writes the
                      same /videos/{idx}/posted leaf via anon auth
                      (rule loosened to match revision1/revision2).
                      Used to confirm the video has been published
                      to the client's destinations after delivery. */}
                  <th style={{ ...TH, textAlign: "center", padding: "8px 12px", width: 80 }}>Posted</th>
                  <th style={{ ...TH, width: 40 }}></th>
                </tr></thead>
                <tbody>{d.videos.map(v => (
                  <tr key={v.id}>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.name} onChange={e => updateVideo(v.id, { name: e.target.value })} placeholder="Video name..." style={{ ...inputSt, fontWeight: 600 }} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.link} onChange={e => updateVideo(v.id, { link: e.target.value })} placeholder="https://..." style={inputSt} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.viewixStatus} options={VIEWIX_STATUSES} colors={VIEWIX_STATUS_COLORS} onChange={val => updateVideo(v.id, { viewixStatus: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.revision1} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val => updateVideo(v.id, { revision1: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><StatusSelect value={v.revision2} options={CLIENT_REVISION_OPTIONS} colors={CLIENT_REVISION_COLORS} onChange={val => updateVideo(v.id, { revision2: val })} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)" }}><input value={v.notes || ""} onChange={e => updateVideo(v.id, { notes: e.target.value })} placeholder="Notes..." style={inputSt} /></td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}>
                      <input type="checkbox"
                        checked={!!v.posted}
                        onChange={e => updateVideo(v.id, { posted: e.target.checked })}
                        title={v.posted ? "Posted — click to unmark" : "Mark as posted"}
                        style={{ cursor: "pointer", accentColor: "#10B981", width: 16, height: 16 }} />
                    </td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-light)", textAlign: "center" }}><button onClick={() => removeVideo(v.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5A6B85", fontSize: 16 }}>x</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <>
      <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Deliveries</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={createBlank} style={{ ...BTN, background: "#374151", color: "var(--fg)" }}>+ Blank Delivery</button>
        </div>
      </div>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 28px 60px" }}>

        {deliveries.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--muted)", background: "var(--card)", borderRadius: 12, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No deliveries yet</div>
            <div style={{ fontSize: 13 }}>Deliveries are created when a project is won. Use "+ Blank Delivery" if you need to add one manually.</div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {deliveries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(d => {
              const ready = d.videos.filter(v => v.viewixStatus === "Completed" || v.viewixStatus === "Ready for Review").length;
              const approved = d.videos.filter(v => v.revision1 === "Approved").length;
              const logoSrc = getAcctLogo(d.clientName) || d.logoUrl;
              const bg = logoBg(getAcctLogoBg(d.clientName));
              return (
                <div key={d.id} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px", cursor: "pointer", transition: "all 0.15s" }} onClick={() => setActiveDeliveryId(d.id)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      {logoSrc && <img key={logoSrc + bg} src={logoSrc} alt="" onError={e => { e.target.style.display = "none"; }} style={{ height: 28, borderRadius: 4, objectFit: "contain", background: bg, padding: 3 }} />}
                      <div>
                        {/* Project name is the primary line — clients often
                            have multiple concurrent deliveries, so the
                            project is what distinguishes one row from
                            another at a glance. Client name lives below
                            as context. */}
                        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg)", lineHeight: 1.3 }}>{d.projectName || "Untitled project"}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                          <span style={{ fontWeight: 600, color: "var(--muted)" }}>{d.clientName}</span>
                          <span style={{ opacity: 0.6 }}> · {d.videos.length} video{d.videos.length !== 1 ? "s" : ""}</span>
                          {/* Surface the shortId so producers can tell multiple
                              deliveries for the same client apart (e.g. repeat
                              engagements that each spawn a new /deliveries/{id}
                              via the Attio webhook). The shortId here should
                              match the /d/{HASH}/... segment in whatever share
                              URL you gave the client. */}
                          {d.shortId && (
                            <span style={{ opacity: 0.6, marginLeft: 6, fontFamily: "'JetBrains Mono',monospace" }}>
                              · /d/{d.shortId}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{ready}/{d.videos.length} ready · {approved}/{d.videos.length} approved</div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); copyLink(d.id); }} style={{ ...BTN, background: "var(--bg)", color: "var(--accent)", border: "1px solid var(--border)" }}>Copy Link</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────
// ShareWithClientModal — Phase A.5 producer "Send the review email"
// flow. Locked design rules:
//
//   - This is the ONLY production trigger for ReadyForReview emails.
//     Editors never fire client emails; notify-finish stays Slack-
//     only forever.
//   - All videos in the delivery are shown in one checklist (no
//     "show all" toggle). Videos with viewixStatus === "Ready for
//     Review" are pre-checked; producer manually toggles others.
//   - Producer note (optional) renders as a quoted block at the top
//     of the email.
//   - On Send: POST /api/send-review-batch with { deliveryId,
//     videoIds, producerNote }. Endpoint reverse-looks up the parent
//     project, builds context, calls send().
//   - Failure modes (no client email, no delivery URL, validation
//     errors) surface as inline error text below the buttons;
//     modal stays open so the producer can fix and retry.
// ───────────────────────────────────────────────────────────────
function ShareWithClientModal({ delivery, onClose, onSent }) {
  const videos = Array.isArray(delivery?.videos) ? delivery.videos.filter(Boolean) : [];
  // Pre-check rule: any video flagged "Ready for Review" by the editor's
  // Finish flow is pre-selected. Producer can still uncheck anything.
  const [checked, setChecked] = useState(() => {
    const init = {};
    for (const v of videos) {
      init[v.id] = v.viewixStatus === "Ready for Review";
    }
    return init;
  });
  const [producerNote, setProducerNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const canSend = checkedCount > 0 && !sending;

  const toggleAll = (val) => {
    const next = {};
    for (const v of videos) next[v.id] = val;
    setChecked(next);
  };

  const submit = async () => {
    setError(null);
    setSending(true);
    // Build the videoIds list from the checked state. Use videoId
    // (the stable identifier) when present, fall back to id.
    const ids = videos
      .filter(v => checked[v.id])
      .map(v => v.videoId || v.id)
      .filter(Boolean);
    try {
      const res = await authFetch("/api/send-review-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId: delivery.id,
          videoIds: ids,
          producerNote: producerNote.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(formatEndpointError(res.status, json));
        setSending(false);
        return;
      }
      onSent({
        state: json.state,
        batchId: json.batchId,
        videoCount: json.videoCount,
      });
    } catch (e) {
      setError(`Network error: ${e.message}`);
      setSending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share videos with client"
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        // Backdrop click closes — but only on the backdrop, not the card.
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div style={{
        maxWidth: 560, width: "100%", maxHeight: "90vh", overflow: "auto",
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: 12, padding: 24,
        boxShadow: "0 24px 48px rgba(0,0,0,0.4)",
      }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", margin: 0 }}>
            Share with client
          </h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {delivery.clientName || "(no client name)"} · {delivery.projectName || "(no project name)"}
          </div>
        </div>

        <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Videos to include ({checkedCount} of {videos.length})
          </span>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="button"
              onClick={() => toggleAll(true)}
              style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: 0 }}
            >Check all</button>
            <button
              type="button"
              onClick={() => toggleAll(false)}
              style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 11, cursor: "pointer", padding: 0 }}
            >Clear</button>
          </div>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 16, maxHeight: 280, overflow: "auto" }}>
          {videos.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--muted)", textAlign: "center" }}>
              No videos in this delivery.
            </div>
          ) : videos.map((v, i) => (
            <label
              key={v.id}
              style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px",
                borderBottom: i < videos.length - 1 ? "1px solid var(--border-light)" : "none",
                cursor: "pointer",
                background: checked[v.id] ? "rgba(16,185,129,0.06)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={!!checked[v.id]}
                onChange={(e) => setChecked(prev => ({ ...prev, [v.id]: e.target.checked }))}
                style={{ accentColor: "#10B981", width: 16, height: 16, cursor: "pointer" }}
              />
              <span style={{ flex: 1, fontSize: 13, color: "var(--fg)", fontWeight: 600 }}>
                {v.name || "(unnamed video)"}
              </span>
              {v.viewixStatus && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "3px 8px",
                  borderRadius: 4,
                  background: VIEWIX_STATUS_COLORS[v.viewixStatus] || "#374151",
                  color: "white",
                }}>{v.viewixStatus}</span>
              )}
            </label>
          ))}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6, display: "block" }}>
            Producer note (optional)
          </label>
          <textarea
            value={producerNote}
            onChange={e => setProducerNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="A quick note for the client — renders as a quoted block at the top of the email."
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--input-bg)",
              color: "var(--fg)",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
              resize: "vertical",
            }}
          />
        </div>

        {error && (
          <div style={{
            marginBottom: 16,
            padding: "10px 12px",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.4)",
            borderRadius: 6,
            color: "#EF4444",
            fontSize: 12,
            lineHeight: 1.45,
          }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => !sending && onClose()}
            disabled={sending}
            style={{ ...BTN, background: "transparent", color: "var(--fg)", border: "1px solid var(--border)" }}
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            style={{
              ...BTN,
              background: canSend ? "#10B981" : "#374151",
              color: "white",
              opacity: canSend ? 1 : 0.6,
              cursor: canSend ? "pointer" : "not-allowed",
            }}
          >{sending ? "Sending…" : `Send ${checkedCount > 0 ? `(${checkedCount})` : ""}`}</button>
        </div>
      </div>
    </div>
  );
}

// Map the endpoint's JSON error responses to readable strings.
function formatEndpointError(status, json) {
  const code = json?.error || "unknown_error";
  switch (code) {
    case "deliveryId required":
      return "Internal error: deliveryId missing from request.";
    case "delivery_not_found":
      return "This delivery record can't be found in Firebase.";
    case "no_project_for_delivery":
      return "No project links to this delivery. Open the project record and set links.deliveryId, then retry.";
    case "no_client_email":
      return "The project has no client email on file. Add clientContact.email to the project before sending.";
    case "no_delivery_url":
      return "This delivery has no usable share URL (missing both shortId and id). Cannot send a review email without a destination.";
    case "no_videos_selected":
      return "Pick at least one video to send.";
    case "send_failed":
      return `Email send failed: ${json.detail || "unknown reason"}`;
    case "Forbidden":
    case "Missing bearer token":
    case "Invalid bearer token":
      return `Auth issue: ${code}. Producers and founders only — editors can't trigger client emails.`;
    default:
      return `Send failed (${status}): ${code}${json.detail ? ` — ${json.detail}` : ""}`;
  }
}
