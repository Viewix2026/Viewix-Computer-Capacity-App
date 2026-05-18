// Shared client-portal UI primitives. Light, brand-compliant,
// mobile-first. Every zone uses these so spacing/type/colour stay
// consistent and the 60/30/10 palette discipline holds (Blue is the
// structure colour, Orange `--accent-2` is the ≤10% highlight, never
// dominant; no alarmist red anywhere).

export function Section({ title, children, style }) {
  return (
    <section className="rise" style={{ marginTop: 16, ...style }}>
      {title && (
        <h2 style={{
          fontSize: 13, fontWeight: 800, color: "var(--navy)",
          textTransform: "uppercase", letterSpacing: "0.06em",
          margin: "0 0 10px 2px",
        }}>
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Card({ children, accent = false, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--card)",
        border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 14,
        padding: "18px 18px",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}>
      {children}
    </div>
  );
}

// Honest gathering-data fallback. Never a blank box, never alarmist.
export function Gathering({ title, message }) {
  return (
    <Section title={title}>
      <div style={{
        background: "var(--card)", border: "1px dashed var(--border)",
        borderRadius: 14, padding: "20px 18px",
        color: "var(--muted)", fontSize: 14, lineHeight: 1.6,
      }}>
        {message}
      </div>
    </Section>
  );
}

// "See the post" external link — the ONLY way a competitor handle
// surfaces in the niche zone (never a headline).
export function SourceLink({ href, label }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 13, fontWeight: 700, color: "var(--accent)",
        textDecoration: "none",
      }}>
      {label} <span aria-hidden style={{ fontSize: 12 }}>↗</span>
    </a>
  );
}

// Compact stat — Montserrat, no mono (mono is an internal-tool tell).
export function Stat({ label, value }) {
  if (value == null) return null;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 18, fontWeight: 800, color: "var(--fg)" }}>{value}</span>
      <span style={{
        fontSize: 11, fontWeight: 700, color: "var(--muted)",
        textTransform: "uppercase", letterSpacing: "0.05em",
      }}>{label}</span>
    </span>
  );
}

export function fmtCount(n) {
  if (n == null) return null;
  const v = +n;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${v}`;
}

// IG-gradient preview tile with the scraped thumbnail layered on top
// (it 403s after IG CDN expiry — the gradient + play icon stay, so the
// tile always looks intentional). Mirrors the internal PostCard
// pattern but light-framed.
export function PreviewTile({ thumbnail, size = 84 }) {
  return (
    <div style={{
      flexShrink: 0, width: size, height: size, borderRadius: 12,
      overflow: "hidden", position: "relative",
      background: "linear-gradient(135deg,#833AB4 0%,#C13584 35%,#FD1D1D 65%,#FCB045 100%)",
    }}>
      {thumbnail && (
        // eslint-disable-next-line jsx-a11y/img-redundant-alt
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          onError={(e) => { e.target.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      <div style={{
        position: "absolute", inset: 0, display: "flex",
        alignItems: "center", justifyContent: "center", pointerEvents: "none",
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: "50%",
          background: "rgba(0,0,0,0.5)", display: "flex",
          alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 10,
        }}>▶</div>
      </div>
    </div>
  );
}
