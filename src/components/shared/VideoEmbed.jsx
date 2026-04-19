// VideoEmbed — renders the right iframe for any URL the producer pastes.
// Supports YouTube, Instagram reels/posts, TikTok videos, and Frame.io
// share links. Anything else falls through to a clickable external link
// card so the feature still works without blowing up.
//
// Used by the Video of the Week block on the home page and the Capacity
// tab editor preview.

function detectEmbed(url) {
  if (!url) return null;
  const u = String(url).trim();

  // YouTube — youtube.com/watch?v=... or youtu.be/... or /shorts/...
  const yt = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) {
    return { kind: "youtube", embedUrl: `https://www.youtube.com/embed/${yt[1]}?rel=0`, aspect: "16 / 9" };
  }

  // Instagram — /p/ or /reel/ or /reels/
  const ig = u.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  if (ig) {
    return { kind: "instagram", embedUrl: `https://www.instagram.com/p/${ig[1]}/embed`, aspect: "9 / 16" };
  }

  // TikTok — /@user/video/123 or /v/123
  const tt = u.match(/tiktok\.com\/(?:@[\w.-]+\/video|v)\/(\d+)/);
  if (tt) {
    return { kind: "tiktok", embedUrl: `https://www.tiktok.com/embed/v2/${tt[1]}`, aspect: "9 / 16" };
  }

  // Frame.io — share URLs (app.frame.io/presentations/... or f.io/... or custom subdomain)
  // Frame.io serves X-Frame-Options that sometimes block iframe, but in practice
  // share-view URLs embed fine. Try it; fall back to a link if the iframe errors.
  if (/(^|\.)frame\.io\//.test(u) || /(^|\.)f\.io\//.test(u)) {
    return { kind: "frameio", embedUrl: u, aspect: "16 / 9" };
  }

  return null;  // unknown provider — caller renders a plain link
}

export function VideoEmbed({ url, aspectRatio }) {
  const detected = detectEmbed(url);
  if (!detected) {
    if (!url) return null;
    // Plain fallback — show the URL as an external link with a play-button
    // thumbnail so it still looks deliberate.
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        aspectRatio: aspectRatio || "16 / 9",
        background: "#1E2A3A", color: "var(--accent)",
        textDecoration: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
        padding: 20, textAlign: "center", gap: 8,
      }}>
        <span style={{ fontSize: 24 }}>▶</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Open video ↗
        </span>
      </a>
    );
  }

  return (
    <div style={{
      aspectRatio: aspectRatio || detected.aspect,
      background: "#000", borderRadius: 8, overflow: "hidden",
      position: "relative",
    }}>
      <iframe
        src={detected.embedUrl}
        title="Video of the week"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0 }}
      />
    </div>
  );
}
