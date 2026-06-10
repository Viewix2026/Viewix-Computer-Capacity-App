// Viewix branded loading indicator — the V logomark coin-spinning in 3D
// perspective with an extruded edge, plus an orbital comet trail tilted
// 44° that passes in front of the mark at the bottom and behind it at
// the top. Ported from the Claude Design handoff ("globe-loader"); the
// constants below are the values the design session landed on: 2.5s
// pulsed spin, 3.3s trail orbiting with the V, 2.1× orbit scale, 74px
// mark on a 200px stage. Self-contained (ships its own <style>), so it
// works in fallbacks that render before the app CSS string mounts.

const VX_BLUE = "#0082FA";
const VX_BLUE_DEEP = "#0064C2";
const DESIGN_MARK = 74;   // mark size the design was tuned at
const DESIGN_STAGE = 200; // stage size at that mark size
const ORBIT_SCALE = 2.1;  // orbit diameter = mark size × this
const EDGE_LAYERS = 7;    // extrusion slab count

const LOADER_CSS = `
.vxl-stage { position: relative; }
.vxl-scene {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  display: grid; place-items: center;
}
.vxl-mark {
  position: relative;
  width: var(--vxl-mark); height: var(--vxl-mark);
  transform-style: preserve-3d;
  animation: vxl-spin var(--vxl-spin-dur) cubic-bezier(0.65, 0, 0.35, 1) infinite;
  will-change: transform;
}
.vxl-mark svg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  backface-visibility: visible;
}
@keyframes vxl-spin {
  from { transform: rotateY(0deg); }
  to   { transform: rotateY(360deg); }
}
.vxl-tilt {
  position: absolute; inset: 0; margin: auto;
  width: var(--vxl-orbit); height: var(--vxl-orbit);
  transform: rotateX(var(--vxl-tilt));
  transform-style: preserve-3d;
}
.vxl-trail {
  position: absolute; inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    rgba(0, 130, 250, 0)    0deg,
    rgba(0, 130, 250, 0.04) 90deg,
    rgba(0, 130, 250, 0.18) 180deg,
    rgba(0, 130, 250, 0.55) 280deg,
    rgba(0, 130, 250, 1)    359.2deg,
    rgba(0, 130, 250, 0)    359.4deg
  );
  -webkit-mask: radial-gradient(closest-side,
    transparent calc(100% - var(--vxl-trail-w) - 1.5px),
    #000        calc(100% - var(--vxl-trail-w)),
    #000        calc(100% - 1px),
    transparent 100%);
  mask: radial-gradient(closest-side,
    transparent calc(100% - var(--vxl-trail-w) - 1.5px),
    #000        calc(100% - var(--vxl-trail-w)),
    #000        calc(100% - 1px),
    transparent 100%);
  animation: vxl-orbit var(--vxl-trail-dur) linear infinite;
  will-change: transform;
}
.vxl-head {
  position: absolute; inset: 0;
  border-radius: 50%;
  animation: vxl-orbit var(--vxl-trail-dur) linear infinite;
  pointer-events: none;
  will-change: transform;
}
.vxl-head::after {
  content: "";
  position: absolute;
  top: 0.75px; left: 50%;
  width: var(--vxl-trail-w); height: var(--vxl-trail-w);
  margin-left: calc(var(--vxl-trail-w) / -2);
  border-radius: 50%;
  background: ${VX_BLUE};
}
@keyframes vxl-orbit {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .vxl-mark { animation-duration: 8s; animation-timing-function: linear; }
  .vxl-trail, .vxl-head { animation-duration: 6s; }
}
`;

// Exact mark geometry (1000×1000 artboard): downward-pointing triangle +
// thick slanted stroke, corners rounded via round-join stroke (w 70).
function MarkSVG({ color, z }) {
  return (
    <svg viewBox="0 0 1000 1000" aria-hidden="true"
         style={z ? { transform: `translateZ(${z}px)` } : undefined}>
      <g fill={color} stroke={color} strokeWidth="70" strokeLinejoin="round">
        <path d="M 133 115 L 422 115 L 280 456 Z" />
        <path d="M 758.7 115 L 873.6 115 L 571 885 L 451.7 885 Z" />
      </g>
    </svg>
  );
}

export function ViewixLoader({ size = DESIGN_MARK, caption, captionStyle }) {
  const k = size / DESIGN_MARK; // scale factor vs the designed size
  const stage = Math.round(DESIGN_STAGE * k);
  const depth = 1.1 * k;        // extrusion per slab
  const trailW = Math.max(3, Math.round(5 * k * 2) / 2);
  const slabs = [];
  for (let i = EDGE_LAYERS; i >= 1; i--) {
    slabs.push(<MarkSVG key={i} color={VX_BLUE_DEEP} z={-i * depth} />);
  }
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
      <style>{LOADER_CSS}</style>
      <div className="vxl-stage" style={{
        width: stage, height: stage,
        perspective: Math.round(stage * 2.8) + "px",
        "--vxl-mark": size + "px",
        "--vxl-orbit": Math.min(stage - 4, Math.round(size * ORBIT_SCALE)) + "px",
        "--vxl-tilt": "44deg",
        "--vxl-spin-dur": "2.5s",
        "--vxl-trail-dur": "3.3s",
        "--vxl-trail-w": trailW + "px",
      }}>
        <div className="vxl-scene">
          <div className="vxl-tilt">
            <div className="vxl-trail" />
            <div className="vxl-head" />
          </div>
          <div className="vxl-mark" role="img" aria-label="Loading">
            {slabs}
            <MarkSVG color={VX_BLUE} />
          </div>
        </div>
      </div>
      {caption && (
        <div style={{ marginTop: 4, fontSize: 14, color: "#5A6B85", ...captionStyle }}>
          {caption}
        </div>
      )}
    </div>
  );
}
