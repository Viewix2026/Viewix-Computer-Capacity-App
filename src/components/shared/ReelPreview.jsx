// ReelPreview — a tile that shows a real, always-fresh preview of an
// Instagram reel. Uses Instagram's official embed iframe which renders
// the first frame + play button, fixing the "black thumbnail" problem
// caused by Apify's scraped displayUrl expiring after ~24h.
//
// Falls back to the expired thumbnail image only if we have a shortCode
// that's somehow unembeddable (very rare). External click-through still
// opens the real Instagram URL in a new tab.

import { useState } from "react";

export function ReelPreview({ shortCode, url, thumbnail, aspectRatio = "1 / 1" }) {
  const [iframeErrored, setIframeErrored] = useState(false);
  const embedUrl = shortCode ? `https://www.instagram.com/p/${shortCode}/embed/captioned` : null;

  return (
    <div style={{ aspectRatio, background: "#000", position: "relative", overflow: "hidden" }}>
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
            width: "100%", height: "100%", border: 0,
            // Instagram's embed has its own padding that we'd rather not see
            // inside our small tiles — translate up a bit so the media fills.
            transform: "scale(1.02)", transformOrigin: "center",
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
