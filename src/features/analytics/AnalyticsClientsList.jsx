// AnalyticsClientsList — Phase 1 setup roster ("Console" layout).
//
// Operator data-table mirroring the Projects tab: search + segmented
// filter top-right, lifecycle section groups (Live / Ready / Needs
// config), per-row config chips, status pill, and an inline
// Enable-analytics toggle. Design handed off from Claude Design; this
// is the implementation wired to the real account + config data.
//
// Inline-style React objects only — no CSS framework, no new deps.
// Existing dark design tokens (CSS vars) + DM Sans / JetBrains Mono.
//
// Data wiring (kept inside this component so AnalyticsApp keeps calling
// it with just `onSelect`):
//   - eligible accounts come from useAccounts()
//   - every client's config is subscribed ONCE at this level (a single
//     /analytics/clients listener) — that powers the live counts, the
//     filter, the lifecycle grouping and the enabled-first sort without
//     fanning out 30+ per-card Firebase listeners.
//   - the inline toggle writes config.enabled (the single gate that
//     decides whether an account costs us money on the next cron run),
//     preserving any handles/competitors/platforms already configured.

import { useState, useEffect, useMemo, Fragment } from "react";
import { initFB, onFB, fbListen, fbSet } from "../../firebase";
import { logoBg } from "../../utils";
import { useAccounts } from "./hooks/useAccounts";
import { emptyConfig } from "./hooks/useAnalyticsConfig";

// ── tokens ──────────────────────────────────────────────────────────
const C = {
  bg: "var(--bg)", fg: "var(--fg)", card: "var(--card)", border: "var(--border)",
  borderLight: "var(--border-light)", muted: "var(--muted)", accent: "var(--accent)",
  accentSoft: "var(--accent-soft)",
  success: "#10B981", successSoft: "rgba(16,185,129,0.12)",
  orange: "#F87700", orangeSoft: "rgba(248,119,0,0.13)",
};
const SANS = "'DM Sans', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const COLS = "28px minmax(220px,2.4fr) minmax(150px,1.1fr) 210px 132px 56px";

// ── normalize a raw (account + merged config) into the table's shape ──
// The real config record keeps handles/competitors as objects keyed by
// platform (instagram/tiktok/youtube), and niche as { freeText }.
function normalize(a) {
  const cfg = a.config || {};
  const handles = cfg.handles || {};
  const competitors = cfg.competitors || {};
  const niche = (cfg.niche && cfg.niche.freeText) || "";
  const cfgHandles = Object.values(handles).some((v) => (v || "").trim());
  const cfgCompetitors = Object.values(competitors).some((arr) => Array.isArray(arr) && arr.length > 0);
  const cfgNiche = !!niche.trim();

  // partnershipType in this app is often "TIER - CHANNEL"
  // (e.g. "STARTER PACK - SOCIAL MEDIA"). Split so the channel can be
  // rendered dimmed after the tier, matching the design.
  const pt = a.partnershipType || a.partnership || "";
  let partnership = pt, channel = a.channel || "";
  if (!channel && pt.includes(" - ")) {
    const parts = pt.split(" - ");
    partnership = parts[0];
    channel = parts.slice(1).join(" - ");
  }

  return {
    id: a.id,
    name: a.companyName || a.name || "Untitled",
    partnership, channel,
    logoUrl: a.logoUrl || "",
    logoBg: a.logoBg || "white",
    enabled: !!(a.analyticsEnabled ?? cfg.enabled),
    cfgHandles, cfgCompetitors, cfgNiche,
    configured: cfgHandles && cfgCompetitors && cfgNiche,
    _raw: a,
  };
}

const lifecycleOf = (c) => (c.enabled ? "live" : c.configured ? "ready" : "needs");
const LIFE = {
  live:  { label: "Live",         dot: C.success, tone: "live" },
  ready: { label: "Ready · off", dot: C.accent,  tone: "ready" },
  needs: { label: "Needs config", dot: C.orange,   tone: "needs" },
};

// ── small helpers ───────────────────────────────────────────────────
function initials(name) {
  const w = name.replace(/[^A-Za-z0-9 &]/g, "").split(/\s+/).filter(Boolean);
  if (w.length === 0) return "?";
  return (w.length === 1 ? w[0].slice(0, 2) : (w[0][0] + w[w.length - 1][0])).toUpperCase();
}
function hueFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// ── logo tile: real <img> with monogram-on-gradient fallback ─────────
function LogoTile({ client, size = 38, radius = 10 }) {
  const [broken, setBroken] = useState(false);
  const hue = hueFor(client.name);
  const showImg = client.logoUrl && !broken;

  if (showImg) {
    const bg = logoBg(client.logoBg);
    const isWhite = client.logoBg === "white";
    return (
      <div style={{
        width: size, height: size, borderRadius: radius, flex: "0 0 auto",
        background: bg === "transparent" ? "rgba(255,255,255,0.04)" : bg,
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
        border: isWhite ? "1px solid rgba(0,0,0,0.06)" : "1px solid " + C.border,
      }}>
        <img src={client.logoUrl} alt="" onError={() => setBroken(true)}
          style={{ maxWidth: "76%", maxHeight: "76%", objectFit: "contain", display: "block" }} />
      </div>
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flex: "0 0 auto",
      background: `linear-gradient(145deg, oklch(0.42 0.12 ${hue}) 0%, oklch(0.30 0.09 ${hue + 24}) 100%)`,
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "1px solid rgba(255,255,255,0.07)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10)",
    }}>
      <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: size * 0.36,
        color: "rgba(255,255,255,0.92)", letterSpacing: "-0.01em" }}>{initials(client.name)}</span>
    </div>
  );
}

// inline Enable/Disable toggle — stops propagation so it never opens the row
function EnableToggle({ on, onToggle }) {
  const w = 38, h = 22, knob = h - 6;
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={on ? "Analytics enabled — click to disable" : "Click to enable analytics"}
      style={{
        width: w, height: h, borderRadius: h, padding: 0, cursor: "pointer", flex: "0 0 auto",
        border: "1px solid " + (on ? "rgba(16,185,129,0.55)" : C.border),
        background: on ? C.success : "rgba(255,255,255,0.05)", position: "relative",
        transition: "all .18s ease", boxShadow: on ? "0 0 0 3px " + C.successSoft : "none",
      }}>
      <span style={{ position: "absolute", top: 2, left: on ? w - knob - 3 : 2, width: knob, height: knob,
        borderRadius: "50%", background: on ? "#fff" : "#8295B0", transition: "left .18s ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)" }} />
    </button>
  );
}

function ConfigChip({ label, set, accent }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, fontFamily: SANS, fontSize: 11,
      fontWeight: 600, padding: "3px 9px 3px 7px", borderRadius: 99,
      border: "1px solid " + (set ? "transparent" : C.border),
      background: set ? (accent ? C.orangeSoft : C.successSoft) : "transparent",
      color: set ? (accent ? "#F9A35A" : "#34D399") : C.muted,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%",
        background: set ? (accent ? C.orange : C.success) : "transparent",
        border: set ? "none" : "1.5px solid " + C.muted }} />
      {label}
    </span>
  );
}

function StatusPill({ label, tone }) {
  const map = {
    live:  { solid: true, bg: C.success, fg: "#04140D" },
    ready: { fg: "#7FA8D9", border: "rgba(0,130,250,0.40)" },
    needs: { fg: "#F9A35A", border: "rgba(248,119,0,0.40)" },
  };
  const s = map[tone] || map.ready;
  return (
    <span style={{
      fontFamily: SANS, fontSize: 11, fontWeight: 800, letterSpacing: "0.07em",
      textTransform: "uppercase", padding: "5px 12px", borderRadius: 7, whiteSpace: "nowrap",
      background: s.solid ? s.bg : "transparent", color: s.fg,
      border: s.solid ? "none" : "1px solid " + s.border,
      boxShadow: s.solid ? "0 2px 10px -3px " + C.success : "none",
    }}>{label}</span>
  );
}

function SectionHeader({ dot, label, count }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
      <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 800, letterSpacing: "0.08em",
        textTransform: "uppercase", color: C.fg }}>{label}</span>
      <span style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>{"·"}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: C.muted }}>{count}</span>
    </div>
  );
}

// ── summary stats ───────────────────────────────────────────────────
function Stat({ value, label, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 28, lineHeight: 1,
        color: color || C.fg }}>{String(value).padStart(2, "0")}</span>
      <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 600, letterSpacing: "0.06em",
        textTransform: "uppercase", color: C.muted }}>{label}</span>
    </div>
  );
}
function SummaryRow({ clients }) {
  const enabled = clients.filter((c) => c.enabled).length;
  const configured = clients.filter((c) => c.configured).length;
  const needs = clients.filter((c) => !c.configured).length;
  const items = [
    <Stat key="e" value={clients.length} label="Eligible" />,
    <Stat key="en" value={enabled} label="Enabled" color={C.accent} />,
    <Stat key="cf" value={configured} label="Configured" color={C.success} />,
    <Stat key="nc" value={needs} label="Needs config" color="#F9A35A" />,
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", background: C.card,
      border: "1px solid " + C.border, borderRadius: 14, padding: "16px 4px" }}>
      {items.map((node, i) => (
        <Fragment key={i}>
          <div style={{ flex: 1, paddingLeft: 24 }}>{node}</div>
          {i < items.length - 1 && <div style={{ width: 1, alignSelf: "stretch",
            background: C.borderLight, margin: "2px 0" }} />}
        </Fragment>
      ))}
    </div>
  );
}

// ── search + segmented filter (Projects-tab pattern) ─────────────────
function SearchBox({ value, onChange }) {
  const [focus, setFocus] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, maxWidth: 340,
      background: C.bg, border: "1px solid " + (focus ? C.accent : C.border), borderRadius: 10,
      padding: "0 13px", height: 38, boxShadow: focus ? "0 0 0 3px " + C.accentSoft : "none" }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2.2">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} placeholder="Search clients…"
        style={{ flex: 1, background: "none", border: "none", outline: "none",
          fontFamily: SANS, fontSize: 13.5, color: C.fg }} />
      {value && <button type="button" onClick={() => onChange("")} style={{ background: "none",
        border: "none", color: C.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>
        {"×"}</button>}
    </div>
  );
}
function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", background: C.bg, border: "1px solid " + C.border,
      borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <button type="button" key={opt.key} onClick={() => onChange(opt.key)} style={{
            fontFamily: SANS, fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 13px",
            borderRadius: 7, border: "1px solid " + (active ? C.border : "transparent"),
            background: active ? C.card : "transparent", color: active ? C.fg : C.muted,
            display: "inline-flex", alignItems: "center", gap: 7 }}>
            {opt.label}
            {opt.count != null && <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600,
              color: active ? (opt.accent || C.accent) : C.muted }}>{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── a table row ──────────────────────────────────────────────────────
function Row({ c, onToggle, onOpen }) {
  const [hover, setHover] = useState(false);
  const on = c.enabled;
  const life = lifecycleOf(c);
  return (
    <div onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: 12,
        padding: "11px 18px", cursor: "pointer", borderBottom: "1px solid " + C.borderLight,
        position: "relative",
        background: hover ? "rgba(0,130,250,0.05)" : on ? "rgba(0,130,250,0.025)" : "transparent",
        transition: "background .12s ease" }}>
      <div style={{ position: "absolute", left: 0, top: 6, bottom: 6, width: 3, borderRadius: 3,
        background: on ? C.accent : "transparent" }} />
      <div style={{ display: "flex", justifyContent: "center", color: C.muted, opacity: hover ? 0.7 : 0.3 }}>
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" />
          <circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" />
          <circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" />
        </svg>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <LogoTile client={c} size={38} radius={10} />
        <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 14.5, color: C.fg,
          letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.name}</span>
      </div>
      <span style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em",
        color: C.muted, textTransform: "uppercase" }}>
        {c.partnership}{c.channel ? <span style={{ opacity: 0.6 }}>{" · " + c.channel}</span> : null}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <ConfigChip label="Handles" set={c.cfgHandles} />
        <ConfigChip label="Comp" set={c.cfgCompetitors} />
        <ConfigChip label="Niche" set={c.cfgNiche} accent />
      </div>
      <div><StatusPill label={LIFE[life].label.replace(" · off", "")} tone={LIFE[life].tone} /></div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <EnableToggle on={on} onToggle={onToggle} />
      </div>
    </div>
  );
}

// ── main component ───────────────────────────────────────────────────
export function AnalyticsClientsList({ onSelect }) {
  const { eligible, loading: accountsLoading } = useAccounts();
  const [configs, setConfigs] = useState({});
  const [configsLoaded, setConfigsLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  // One listener for every client's config.
  // Returns { [accountId]: { config: {...} } }.
  useEffect(() => {
    initFB();
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen("/analytics/clients", (data) => {
        setConfigs(data || {});
        setConfigsLoaded(true);
      });
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const loading = accountsLoading || !configsLoaded;

  // Merge each eligible account with its config, then normalize.
  const clients = useMemo(() => eligible.map((a) => {
    const cfg = configs[a.id]?.config;
    return normalize({ ...a, config: cfg, analyticsEnabled: !!cfg?.enabled });
  }), [eligible, configs]);

  const counts = useMemo(() => ({
    all: clients.length,
    enabled: clients.filter((c) => c.enabled).length,
    disabled: clients.filter((c) => !c.enabled).length,
    needs: clients.filter((c) => !c.configured).length,
  }), [clients]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (filter === "enabled") return c.enabled;
      if (filter === "disabled") return !c.enabled;
      if (filter === "needs") return !c.configured;
      return true;
    });
  }, [clients, query, filter]);

  // group: Live -> Ready -> Needs config, alphabetical within
  const groups = useMemo(() => {
    const g = { live: [], ready: [], needs: [] };
    filtered.forEach((c) => g[lifecycleOf(c)].push(c));
    Object.values(g).forEach((rows) => rows.sort((a, b) => a.name.localeCompare(b.name)));
    return [["live", g.live], ["ready", g.ready], ["needs", g.needs]];
  }, [filtered]);

  // Flip config.enabled, preserving anything already configured so a
  // page refresh (or a later cron) doesn't lose handles/competitors.
  const toggle = (c) => {
    const id = c._raw.id;
    const base = configs[id]?.config || emptyConfig(id, c._raw.companyName);
    fbSet(`/analytics/clients/${id}/config`, {
      ...base, enabled: !c.enabled, updatedAt: new Date().toISOString(),
    });
  };
  const open = (c) => onSelect?.(c._raw.id);

  const filterOpts = [
    { key: "all", label: "All", count: counts.all },
    { key: "enabled", label: "Enabled", count: counts.enabled, accent: C.accent },
    { key: "disabled", label: "Disabled", count: counts.disabled },
    { key: "needs", label: "Needs config", count: counts.needs, accent: "#F9A35A" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
      background: C.bg, color: C.fg, fontFamily: SANS }}>
      <style>{"@keyframes vxShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}"}</style>

      {/* header — matches the dashboard pattern */}
      <header style={{ padding: "12px 28px", background: C.card, borderBottom: "1px solid " + C.border,
        display: "flex", alignItems: "center", justifyContent: "space-between", flex: "0 0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
          <span style={{ fontWeight: 700, fontSize: 20, letterSpacing: "-0.01em" }}>Analytics</span>
          <span style={{ fontSize: 14, color: C.muted }}>Viewix Growth Intelligence</span>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, letterSpacing: "0.1em",
          color: C.accent, background: C.accentSoft, border: "1px solid rgba(0,130,250,0.3)",
          padding: "5px 12px", borderRadius: 7, textTransform: "uppercase" }}>Phase 1 · Setup</span>
      </header>

      {/* controls — search + filter top-right (Projects pattern) */}
      <div style={{ padding: "14px 28px", borderBottom: "1px solid " + C.border, display: "flex",
        alignItems: "center", gap: 16, flexWrap: "wrap", flex: "0 0 auto" }}>
        <div style={{ flex: 1 }} />
        <SearchBox value={query} onChange={setQuery} />
        <Segmented value={filter} onChange={setFilter} options={filterOpts} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 60px" }}>
        <div style={{ maxWidth: 1560, margin: "0 auto" }}>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: C.muted, maxWidth: 760, margin: "0 0 18px" }}>
            Eligible accounts appear below. Click into one to configure handles, competitors and a niche
            label. Nothing is scraped or costs anything until you flip{" "}
            <span style={{ color: C.fg, fontWeight: 600 }}>Enable analytics</span>.
          </p>

          <div style={{ marginBottom: 20 }}><SummaryRow clients={clients} /></div>

          {loading ? (
            <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 14,
              overflow: "hidden" }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} style={{ height: 60, borderBottom: "1px solid " + C.borderLight,
                  background: "linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.035) 50%, transparent 70%)",
                  backgroundSize: "200% 100%", animation: "vxShimmer 1.4s infinite" }} />
              ))}
            </div>
          ) : clients.length === 0 ? (
            <div style={{ textAlign: "center", padding: "70px 20px", color: C.muted,
              background: C.card, border: "1px dashed " + C.border, borderRadius: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.fg, marginBottom: 6 }}>
                No eligible accounts yet</div>
              <div style={{ fontSize: 14 }}>
                Accounts appear here once they have a partnership type set in the Accounts tab.
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "70px 20px", color: C.muted }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.fg, marginBottom: 6 }}>
                No clients match</div>
              <div style={{ fontSize: 14 }}>
                {query ? <>Nothing for {"“"}<span style={{ color: C.fg }}>{query}</span>{"”"}.
                  Try another name.</> : "Adjust the filter to see eligible accounts."}
              </div>
            </div>
          ) : (
            <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 14,
              overflow: "hidden" }}>
              {/* column header */}
              <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: 12,
                padding: "12px 18px", borderBottom: "1px solid " + C.border,
                background: "rgba(255,255,255,0.015)" }}>
                {["", "Client", "Partnership", "Config", "Status", ""].map((h, i) => (
                  <div key={i} style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 800,
                    letterSpacing: "0.09em", textTransform: "uppercase", color: C.muted,
                    textAlign: i === 5 ? "right" : "left" }}>{h}</div>
                ))}
              </div>
              {groups.map(([key, rows]) => rows.length === 0 ? null : (
                <div key={key}>
                  <div style={{ padding: "13px 18px 9px", borderBottom: "1px solid " + C.borderLight,
                    background: "rgba(255,255,255,0.01)" }}>
                    <SectionHeader dot={LIFE[key].dot} label={LIFE[key].label} count={rows.length} />
                  </div>
                  {rows.map((c) => (
                    <Row key={c.id} c={c} onToggle={() => toggle(c)} onOpen={() => open(c)} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
