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

// Small tiles (< ~120px wide) can't render an Instagram embed usefully —
// the iframe content becomes unreadably small. For those spots we render
// a solid-colour placeholder with a play icon. The full embed only kicks
// in for tiles wide enough to actually show the video.
export function ReelPreview({ shortCode, url, thumbnail, aspectRatio = "1 / 1", compact = false }) {
  const [iframeErrored, setIframeErrored] = useState(false);
  const sc = shortCode || shortCodeFromUrl(url);

  if (compact) {
    // Compact: try the (possibly expired) thumbnail, fall back to a play-
    // button placeholder. No iframe — too heavy for a 56x56 tile.
    return (
      <div style={{ aspectRatio, background: "#1E2A3A", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy"
            onError={e => { e.target.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
        {/* Play icon always renders as overlay so it's visible even when
            the thumbnail loads (and if it fails, the icon is the fallback). */}
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>▶</div>
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
