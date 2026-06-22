// ReelPreview — a tile that shows a real, always-fresh preview of an
// Instagram reel. Uses Instagram's official embed iframe which renders
// the first frame + play button, fixing the "black thumbnail" problem
// caused by Apify's scraped displayUrl expiring after ~24h.
//
// Falls back to the expired thumbnail image only if we have a shortCode
// that's somehow unembeddable (very rare). External click-through still
// opens the real Instagram URL in a new tab.

import { useState } from "react";

// Derive an Instagram shortcode from any /p/ /reel/ /reels/ URL. Saves
// every caller from having to know the regex.
export function shortCodeFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Derive the 11-char video id from any YouTube URL shape. Unlike Instagram
// CDN thumbnails (which expire within hours), YouTube's
// i.ytimg.com/vi/<id>/hqdefault.jpg is permanent and free — so a YouTube
// example gives us a real, never-expiring still for free. Handles watch?v=
// (incl. v not first param + &t= suffix), youtu.be/<id>?si=, /shorts/,
// /embed/, /live/, /v/, m.youtube, and youtube-nocookie.
export function youTubeIdFromUrl(url) {
  if (!url) return null;
  // Trailing (?![A-Za-z0-9_-]) means a longer slug (youtu.be/ABCDEFGHIJKL)
  // fails rather than silently truncating to a wrong 11-char id; `i` flag
  // tolerates an upper-case host. Video ids stay case-sensitive (the class
  // already covers both cases).
  const m = String(url).match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i
  );
  return m ? m[1] : null;
}

// Small tiles (< ~120px wide) can't render an Instagram embed usefully —
// the iframe content becomes unreadably small. For those spots we render
// a solid-colour placeholder with a play icon. The full embed only kicks
// in for tiles wide enough to actually show the video.
export function ReelPreview({ shortCode, url, thumbnail, aspectRatio = "1 / 1", compact = false, poster = false, showPlay = true }) {
  const [iframeErrored, setIframeErrored] = useState(false);

  if (poster) {
    // Poster mode: a static tile, no iframe. An IG-branded gradient base
    // that always looks intentional, the real still (`thumbnail`) layered
    // on top when it loads, and a play glyph so the tile reads as "video".
    // Used by the Format Library grid, where dozens of live IG embeds were
    // both heavy and unreliable (they rendered as empty white boxes). The
    // gradient stays whenever the thumbnail is missing or expired, so a
    // card is never blank. `key={thumbnail}` re-mounts the img when the
    // src changes so a fresh src isn't stuck hidden by a prior onError.
    return (
      <div style={{
        aspectRatio,
        background: "linear-gradient(135deg, #833AB4 0%, #C13584 35%, #FD1D1D 65%, #FCB045 100%)",
        position: "relative", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy" key={thumbnail}
            // YouTube's i.ytimg.com returns a 120×90 grey "no thumbnail" image
            // at HTTP 200 for deleted/private videos — onError never fires, so
            // catch the tell-tale tiny dimensions onLoad and fall back to the
            // gradient. A real hqdefault is 480 wide, IG thumbs wider still.
            onLoad={e => { if (e.target.naturalWidth && e.target.naturalWidth <= 120) e.target.style.display = "none"; }}
            onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
        {showPlay && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16 }}>▶</div>
          </div>
        )}
      </div>
    );
  }

  // Only the iframe (default) mode needs the Instagram shortcode.
  const sc = shortCode || shortCodeFromUrl(url);

  if (compact) {
    // Compact: try the (possibly expired) thumbnail, fall back to an
    // Instagram-coloured gradient placeholder. No iframe — too heavy
    // for a 32–80px tile. The gradient keeps compact tiles looking
    // polished even when the scraped thumbnail URL has expired
    // (Apify's IG CDN URLs die after ~24h).
    return (
      <div style={{
        aspectRatio,
        background: "linear-gradient(135deg, #833AB4 0%, #C13584 35%, #FD1D1D 65%, #FCB045 100%)",
        position: "relative", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy"
            onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
        {/* Play icon always renders as overlay so it's visible even when
            the thumbnail loads (and if it fails, the icon is the fallback). */}
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>▶</div>
        </div>
      </div>
    );
  }

  // `/embed` (no /captioned) is Instagram's more compact embed — shows the
  // media + a small top bar. /captioned tacks on the full caption which
  // eats more vertical space and is usually unwanted in a tile grid.
  const embedUrl = sc ? `https://www.instagram.com/p/${sc}/embed` : null;

  return (
    <div style={{ aspectRatio, background: "#fff", position: "relative", overflow: "hidden" }}>
      {embedUrl && !iframeErrored ? (
        <iframe
          src={embedUrl}
          title="Instagram reel preview"
          loading="lazy"
          scrolling="no"
          allowtransparency="true"
          allow="encrypted-media"
          onError={() => setIframeErrored(true)}
          style={{
            // Fill the tile exactly — no transform cropping.
            position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: 0,
          }}
        />
      ) : thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          onError={e => { e.target.style.display = "none"; }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", color: "rgba(232,236,244,0.4)", fontSize: 11 }}>
          {url ? "No preview" : "No link"}
        </div>
      )}
    </div>
  );
}
