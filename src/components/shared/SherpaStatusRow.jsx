// Shared status row rendered inside the Brand Truth "Inputs" card on
// both the Social Media Organic and Meta Ads tabs. Shows whether the
// Client Sherpa Google Doc has been fetched, when it was cached, and
// surfaces fetch errors (doc not shared, malformed URL, stale cache
// after a transient failure, etc.).
//
// Data comes from /sherpaCacheMeta/{clientId} — the metadata-only
// counterpart to /sherpaCache/{clientId} (which holds the full doc
// text server-side only). The parent component is responsible for
// resolving the matching /clients record via matchSherpaForName and
// passing the linked record + meta entry as props.

function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function formatBytes(b) {
  if (!b || b < 1024) return `${b || 0}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

const baseRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 11,
  marginBottom: 10,
};

const btnBase = {
  padding: "3px 9px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--input-bg)",
  color: "var(--fg)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};

export function SherpaStatusRow({ linkedClient, meta, refreshing, refreshError, onRefresh }) {
  // Resolver hasn't matched a /clients record at all — nothing to render.
  if (!linkedClient) {
    return (
      <div style={{ ...baseRow, background: "rgba(148,163,184,0.06)", border: "1px solid var(--border)", color: "var(--muted)" }}>
        <span>No Sherpa linked for this company. Add a client record with a Google Doc URL to enable Sherpa-grounded generations.</span>
      </div>
    );
  }

  const errCode = meta?.error?.code || null;
  const hasGoodCache = !!meta?.fetchedAt && !errCode;
  const stale = !!errCode && !!meta?.fetchedAt;

  // Variant-specific copy + styling
  let bg = "rgba(34,197,94,0.06)";
  let border = "1px solid rgba(34,197,94,0.25)";
  let color = "var(--fg)";
  let copy;
  let showButton = true;
  let buttonLabel = refreshing ? "Refreshing…" : "Refresh Sherpa";

  if (hasGoodCache) {
    copy = (
      <>Sherpa cached {relativeTime(meta.fetchedAt)} · {formatBytes(meta.byteSize)}{meta.truncated ? " · truncated to 25k chars" : ""}</>
    );
  } else if (errCode === "not_shared") {
    bg = "rgba(239,68,68,0.08)";
    border = "1px solid rgba(239,68,68,0.3)";
    color = "#EF4444";
    copy = <>Sherpa not shared publicly — set the Google Doc to &quot;Anyone with the link&quot; and retry.</>;
    buttonLabel = refreshing ? "Retrying…" : "Retry";
  } else if (errCode === "malformed_url") {
    bg = "rgba(239,68,68,0.08)";
    border = "1px solid rgba(239,68,68,0.3)";
    color = "#EF4444";
    copy = <>Sherpa URL on the client record is invalid. Update <code>{linkedClient.name}</code>&apos;s docUrl.</>;
    showButton = false;
  } else if (errCode === "not_linked") {
    bg = "rgba(148,163,184,0.06)";
    border = "1px solid var(--border)";
    color = "var(--muted)";
    copy = <>No Google Doc URL on the client record. Add one to enable Sherpa-grounded generations.</>;
    showButton = false;
  } else if (stale) {
    bg = "rgba(245,158,11,0.08)";
    border = "1px solid rgba(245,158,11,0.3)";
    color = "#F59E0B";
    copy = <>Using stale Sherpa — last refresh failed {relativeTime(meta.lastRetryAt)}: {meta.error?.message || meta.error?.code}</>;
    buttonLabel = refreshing ? "Retrying…" : "Retry";
  } else if (errCode) {
    bg = "rgba(239,68,68,0.08)";
    border = "1px solid rgba(239,68,68,0.3)";
    color = "#EF4444";
    copy = <>Last Sherpa fetch failed: {meta?.error?.message || errCode}</>;
    buttonLabel = refreshing ? "Retrying…" : "Retry";
  } else {
    // Resolved client, has docUrl, no cache yet — auto-fetched on first
    // generation. Show a soft hint so the producer knows they don't have
    // to do anything but can hit the button if they want it pre-warmed.
    bg = "rgba(148,163,184,0.06)";
    border = "1px solid var(--border)";
    color = "var(--muted)";
    copy = <>Sherpa not yet cached — will fetch on first generate. {linkedClient.docUrl ? null : "(No docUrl set yet.)"}</>;
    buttonLabel = refreshing ? "Fetching…" : "Fetch now";
    if (!linkedClient.docUrl) showButton = false;
  }

  return (
    <div>
      <div style={{ ...baseRow, background: bg, border, color }}>
        <span>{copy}</span>
        {showButton && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            style={{ ...btnBase, opacity: refreshing ? 0.5 : 1 }}
          >
            {buttonLabel}
          </button>
        )}
      </div>
      {refreshError && (
        <div style={{ marginBottom: 10, padding: "6px 10px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, fontSize: 11, color: "#EF4444" }}>
          {refreshError}
        </div>
      )}
    </div>
  );
}
