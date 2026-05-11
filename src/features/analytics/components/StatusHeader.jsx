// StatusHeader — single-glance health for one client. Top zone of
// the per-client dashboard.
//
// Renders precomputed truth only. Every number visible here was
// already computed in api/_analyticsScoring.js and written to
// /analytics/clients/{id}/{status,momentum,baselines}. No math in
// this component.

import { STATUS_COLORS, momentumColor } from "../scoringDisplay/colors";
import { statusBadgeText } from "../scoringDisplay/labels";
import { fmtCount, fmtDelta } from "../utils/displayFormatters";

export function StatusHeader({ data, config }) {
  const { status, momentum, baselines, lastRecomputeAt, lastRefreshedAt, followers } = data || {};

  const platform = "instagram"; // v1
  const followerCount = baselines?.followerCount?.[platform] ?? null;

  // Follower delta over the last 30 days. Pulled from
  // /analytics/followers history (precomputed-ish — it's just a
  // selection over snapshots, no math here).
  const { current: followNow, prev30d: followPrev } = pickFollowerHistory(followers, platform);
  const followerDelta = (followNow != null && followPrev != null && followPrev > 0)
    ? (followNow - followPrev) / followPrev
    : null;

  return (
    <div style={{
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "20px 24px",
      marginBottom: 16,
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 24, alignItems: "center" }}>
        {/* Status badge */}
        <StatusBadgeBlock status={status} />

        {/* Momentum + reason line (the most important explainability
            UX in the whole tab — the score is never alone) */}
        <MomentumBlock momentum={momentum} />

        {/* Quick stats — followers + last refresh */}
        <QuickStats
          followerCount={followerCount}
          followerDelta={followerDelta}
          lastRefreshedAt={lastRefreshedAt?.[platform] || null}
          lastRecomputeAt={lastRecomputeAt}
        />
      </div>
    </div>
  );
}

function StatusBadgeBlock({ status }) {
  const state = status?.state || "insufficient";
  const colors = STATUS_COLORS[state] || STATUS_COLORS.insufficient;
  const text = statusBadgeText(state);
  return (
    <div style={{ minWidth: 200 }}>
      <div style={{
        fontSize: 9, fontWeight: 800, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
      }}>
        Status
      </div>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "8px 14px",
        background: colors.bg, color: colors.fg,
        border: `1px solid ${colors.border}`,
        borderRadius: 999,
        fontSize: 13, fontWeight: 800,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: colors.fg, boxShadow: `0 0 6px ${colors.fg}`,
        }}/>
        {text}
      </div>
      {status?.reason && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.45, maxWidth: 280 }}>
          {status.reason}
        </div>
      )}
    </div>
  );
}

function MomentumBlock({ momentum }) {
  const score = momentum?.score;
  const reasonLine = momentum?.reasonLine;
  const colour = momentumColor(score);
  return (
    <div>
      <div style={{
        fontSize: 9, fontWeight: 800, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
      }}>
        Momentum
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 32, fontWeight: 800, color: colour,
          textShadow: `0 0 12px ${colour}22`,
          lineHeight: 1,
        }}>
          {score != null ? score : "—"}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)" }}>
          / 100
        </span>
      </div>
      {reasonLine && (
        <div style={{ fontSize: 12, color: "var(--fg)", marginTop: 8, lineHeight: 1.45, maxWidth: 480 }}>
          {reasonLine}
        </div>
      )}
    </div>
  );
}

function QuickStats({ followerCount, followerDelta, lastRefreshedAt, lastRecomputeAt }) {
  return (
    <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 10, minWidth: 180 }}>
      <div>
        <div style={{
          fontSize: 9, fontWeight: 800, color: "var(--muted)",
          textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4,
        }}>
          Followers (IG)
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)", fontFamily: "'JetBrains Mono', monospace" }}>
          {followerCount != null ? fmtCount(followerCount) : "—"}
        </div>
        {followerDelta != null && (
          <div style={{
            fontSize: 11,
            color: followerDelta > 0 ? "#10B981" : followerDelta < 0 ? "#EF4444" : "var(--muted)",
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 2,
          }}>
            {fmtDelta(followerDelta, 1)} (30d)
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.5 }}>
        {lastRefreshedAt ? `Scraped ${relativeTime(lastRefreshedAt)}` : "Never scraped"}
        {lastRecomputeAt ? <><br/>Scored {relativeTime(lastRecomputeAt)}</> : null}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function relativeTime(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const m = Math.floor(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    const w = Math.floor(d / 7);
    return `${w}w ago`;
  } catch { return ""; }
}

function pickFollowerHistory(followers, platform) {
  const map = (followers && followers[platform]) || {};
  const dates = Object.keys(map).sort();
  if (!dates.length) return { current: null, prev30d: null };
  const current = map[dates[dates.length - 1]]?.count ?? null;
  const targetMs = Date.now() - 30 * 24 * 3600 * 1000;
  let prev30d = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (new Date(dates[i]).getTime() <= targetMs) {
      prev30d = map[dates[i]]?.count ?? null;
      break;
    }
  }
  return { current, prev30d };
}
