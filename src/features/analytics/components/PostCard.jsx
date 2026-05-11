// PostCard — shared post visual. Renders one video with its
// thumbnail, caption excerpt, metrics, and the scoring labels the
// API precomputed.
//
// Pure display. Every number it shows came from
// /analytics/videos/{id}/{platform}/{videoId}/scoring — nothing is
// derived here.

import { fmtCount, fmtPct } from "../utils/displayFormatters";
import { overperformanceLabel, repeatabilityLabel } from "../scoringDisplay/labels";

export function PostCard({ video }) {
  const { post, snapshot, scoring } = video;

  // Prefer the precomputed label (carries server-side rounding).
  // Fall back to deriving from the score for safety; both paths are
  // display-only.
  const overLabel = scoring?.overperformanceLabel
    || overperformanceLabel(scoring?.overperformanceScore);
  const repLabel = scoring?.repeatabilityLabel
    || repeatabilityLabel(scoring?.repeatabilityScore);

  const isOneOff = repLabel === "One-off spike — don't chase";
  const isRepeatable = repLabel === "Likely repeatable";

  const borderColor = isRepeatable
    ? "rgba(16,185,129,0.5)"
    : isOneOff
    ? "rgba(239,68,68,0.4)"
    : "var(--border)";

  const open = () => {
    if (post?.url) window.open(post.url, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      onClick={open}
      style={{
        display: "flex",
        gap: 14,
        background: "var(--card)",
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: 12,
        cursor: post?.url ? "pointer" : "default",
        boxShadow: isRepeatable ? "0 0 14px rgba(16,185,129,0.18)" : "none",
        transition: "border-color 0.15s",
      }}>
      {/* Thumbnail */}
      <div style={{
        flexShrink: 0,
        width: 96, height: 96,
        borderRadius: 8,
        background: "var(--bg)",
        overflow: "hidden",
        position: "relative",
      }}>
        {post?.thumbnail ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={post.thumbnail}
            alt=""
            onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24, opacity: 0.4,
          }}>🎬</div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Labels row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {overLabel && (
            <Pill colour="#10B981">{overLabel}</Pill>
          )}
          {isRepeatable && (
            <Pill colour="#10B981" subdued>Likely repeatable</Pill>
          )}
          {isOneOff && (
            <Pill colour="#EF4444" subdued>One-off spike</Pill>
          )}
          {(scoring?.tags || []).includes("high_engagement") && !isOneOff && (
            <Pill colour="#0082FA" subdued>High engagement</Pill>
          )}
          {(scoring?.tags || []).includes("broad_reach") && (
            <Pill colour="#F59E0B" subdued>Broad reach</Pill>
          )}
        </div>

        {/* Caption excerpt */}
        <div style={{
          fontSize: 13, fontWeight: 600, color: "var(--fg)",
          lineHeight: 1.4,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {post?.caption || "(no caption)"}
        </div>

        {/* Metrics row */}
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 12,
          fontSize: 11, color: "var(--muted)",
          fontFamily: "'JetBrains Mono', monospace",
          marginTop: 2,
        }}>
          <Metric label="Views" value={fmtCount(snapshot?.views)} />
          <Metric label="Likes" value={fmtCount(snapshot?.likes)} />
          <Metric label="Comments" value={fmtCount(snapshot?.comments)} />
          {snapshot?.engagementRate != null && (
            <Metric label="ER" value={fmtPct(snapshot.engagementRate / 100, 2)} />
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({ colour, subdued = false, children }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "3px 8px",
      borderRadius: 999,
      background: `${colour}${subdued ? "22" : "33"}`,
      color: colour,
      border: `1px solid ${colour}${subdued ? "44" : "66"}`,
      fontSize: 10, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: 0.3,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function Metric({ label, value }) {
  return (
    <span>
      <span style={{ opacity: 0.65, fontWeight: 500, marginRight: 4 }}>{label}</span>
      <span style={{ color: "var(--fg)", fontWeight: 700 }}>{value}</span>
    </span>
  );
}
