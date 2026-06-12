// src/reviews-site/main.js
//
// viewixreviews.com.au page logic — a faithful port of the design
// spec's render code (docs/plans/viewix-reviews-design/
// viewixreviews.html) with live data: reviews from
// GET /api/public/reviews, testimonials from build-time repo JSON.

import "./styles.css";
import TESTIMONIALS from "./testimonials.json";
import {
  avatarColour, initials, fmtDate, badgeText,
  buildStream, rowChunks, ROW_SPEEDS_PPS, durationForTrack, thumbnailUrlsFor,
} from "./stream.js";

function reviewCard(r) {
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="head">
      <span class="avatar"></span>
      <div class="who">
        <div class="name"></div>
        <div class="date"></div>
      </div>
    </div>
    <div class="stars"></div>
    <p class="text"></p>
    <div class="gline"><svg class="gicon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.81z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3a7.22 7.22 0 0 1-10.8-3.8H1.27v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.27 14.29a7.21 7.21 0 0 1 0-4.58v-3.1H1.27a12 12 0 0 0 0 10.78l4-3.1z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.59 1.8l3.43-3.44A11.97 11.97 0 0 0 1.27 6.61l4 3.1A7.22 7.22 0 0 1 12 4.77z"/></svg> Google review</div>
  `;
  const avatar = el.querySelector(".avatar");
  avatar.style.background = avatarColour(r.authorDisplayName);
  avatar.textContent = initials(r.authorDisplayName);
  el.querySelector(".name").textContent = r.authorDisplayName;
  el.querySelector(".date").textContent = fmtDate(r.createdAt);
  const stars = el.querySelector(".stars");
  stars.setAttribute("aria-label", `${r.rating} out of 5 stars`);
  stars.textContent = "★".repeat(Math.max(1, Math.min(5, r.rating || 5)));
  el.querySelector(".text").textContent = r.text || "";
  /* Design decision: ownerReply is accepted in the data shape but NOT
     rendered — the page reads cleaner as pure client voice. */

  // Clamp rule: 7 lines, expand on tap. Only add the toggle if clamped.
  // Checked on first paint, again once fonts settle (the Montserrat
  // swap reflows line counts — measuring before it lands misses real
  // overflow), and on first visibility (rAF never fires in a hidden/
  // background tab — IntersectionObserver backstops it).
  const ensureClampToggle = () => {
    const t = el.querySelector(".text");
    if (!t || el.querySelector(".more")) return;
    if (t.scrollHeight > t.clientHeight + 2) {
      const btn = document.createElement("button");
      btn.className = "more";
      btn.textContent = "Read more";
      btn.addEventListener("click", () => {
        const on = el.classList.toggle("expanded");
        btn.textContent = on ? "Show less" : "Read more";
      });
      t.after(btn);
    }
  };
  // Scheduling must survive a hidden/background tab, where rAF and
  // IntersectionObserver are suspended entirely: setTimeout still runs
  // and reading scrollHeight forces layout even while hidden, and
  // fonts.ready must be a DIRECT call (wrapping it in rAF would die
  // with the rest). rAF + IO cover the visible-tab fast path.
  setTimeout(ensureClampToggle, 0);
  requestAnimationFrame(ensureClampToggle);
  document.fonts?.ready?.then(ensureClampToggle);
  new IntersectionObserver((entries, obs) => {
    if (entries.some((e) => e.isIntersecting)) { ensureClampToggle(); obs.disconnect(); }
  }).observe(el);
  return el;
}

function testimonialCard(t) {
  const el = document.createElement("article");
  el.className = "vcard" + (t.aspect === "9:16" ? " portrait" : "");
  el.innerHTML = `
    <div class="vmedia">
      <button class="vplay">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5v15l13-7.5z"/></svg>
      </button>
    </div>
    <div class="vmeta">
      <div class="tag">Client testimonial</div>
      <div class="client"></div>
      <div class="title"></div>
    </div>
  `;
  el.querySelector(".vplay").setAttribute("aria-label", `Play testimonial from ${t.clientName}`);
  el.querySelector(".client").textContent = t.clientName;
  el.querySelector(".title").textContent = t.title || "";

  // Real video thumbnail in the facade so people can see what they're
  // about to play (still NO iframe until click). Walks the candidate
  // list on error; if all fail, the brand-gradient facade remains.
  const thumbs = thumbnailUrlsFor(t);
  if (thumbs.length) {
    const img = document.createElement("img");
    img.className = "vthumb";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    let i = 0;
    img.src = thumbs[i];
    img.addEventListener("error", () => {
      i += 1;
      if (i < thumbs.length) img.src = thumbs[i];
      else img.remove();
    });
    // maxresdefault sometimes "succeeds" as a 120x90 grey placeholder
    // instead of 404ing — treat that as a miss too.
    img.addEventListener("load", () => {
      if (img.naturalWidth <= 120 && i + 1 < thumbs.length) { i += 1; img.src = thumbs[i]; }
    });
    el.querySelector(".vmedia").prepend(img);
  }

  // Facade pattern: the iframe is created ON CLICK only. Non-negotiable
  // (performance + privacy). Aspect ratio is locked in CSS pre-load.
  el.querySelector(".vplay").addEventListener("click", () => {
    const media = el.querySelector(".vmedia");
    const src = t.provider === "youtube"
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.videoId)}?autoplay=1`
      : `https://player.vimeo.com/video/${encodeURIComponent(t.videoId)}?autoplay=1`;
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.allow = "autoplay; encrypted-media; picture-in-picture";
    frame.allowFullscreen = true;
    frame.title = `Testimonial: ${t.clientName}`;
    media.replaceChildren(frame);
  });
  return el;
}

function renderWall(reviews) {
  const wall = document.getElementById("wall");
  const stream = buildStream(reviews, TESTIMONIALS);
  const chunks = rowChunks(stream);

  chunks.forEach((items, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.dir = i % 2 ? "r" : "l";

    const track = document.createElement("div");
    track.className = "track";
    items.forEach((it) =>
      track.appendChild(it.kind === "review" ? reviewCard(it.data) : testimonialCard(it.data))
    );

    /* Both copies live in one track for a seamless -50% loop. Each
       DUPLICATED CARD carries aria-hidden itself (not a wrapper) so
       screen readers hear each review exactly once and the static-grid
       CSS hides duplicates via `.track > [aria-hidden]`. */
    items.forEach((it) => {
      const dup = it.kind === "review" ? reviewCard(it.data) : testimonialCard(it.data);
      dup.setAttribute("aria-hidden", "true");
      dup.inert = true; // duplicate's buttons drop out of tab order
      track.appendChild(dup);
    });

    row.appendChild(track);
    wall.appendChild(row);

    // Constant-speed motion: duration derives from the track's real
    // width (static per dataset — cards are fixed-width). Set after
    // attach (layout exists even in hidden tabs) and refined once
    // fonts settle, since text width nudges the track a little.
    const pps = ROW_SPEEDS_PPS[i % ROW_SPEEDS_PPS.length];
    const applyDuration = () =>
      track.style.setProperty("--dur", durationForTrack(track.scrollWidth, pps));
    applyDuration();
    document.fonts?.ready?.then(applyDuration);
  });
}

function renderBadge(meta) {
  const b = badgeText(meta);
  if (!b) return;
  const badge = document.getElementById("rating-badge");
  const text = document.getElementById("badge-text");
  text.innerHTML = ""; // derived values only, built as nodes
  text.append(`${b.rating} `);
  const star = document.createElement("span");
  star.className = "star";
  star.textContent = "★";
  text.append(star, ` · ${b.count} Google reviews`);
  badge.hidden = false;
}

function renderEmptyState() {
  document.body.classList.add("is-empty");
  const vg = document.getElementById("empty-vgrid");
  TESTIMONIALS.forEach((t) => vg.appendChild(testimonialCard(t)));
}

function wirePause() {
  const pauseBtn = document.getElementById("pause-btn");
  pauseBtn.hidden = false;
  pauseBtn.addEventListener("click", () => {
    const paused = document.body.classList.toggle("is-paused");
    pauseBtn.setAttribute("aria-pressed", String(paused));
    document.getElementById("pause-label").textContent = paused ? "Play motion" : "Pause motion";
    document.getElementById("pause-ico").innerHTML = paused
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
  });
}

async function loadData() {
  try {
    const r = await fetch("/api/public/reviews");
    if (!r.ok) throw new Error(`reviews endpoint ${r.status}`);
    return await r.json();
  } catch (e) {
    // Local design QA only: `vite dev` has no /api functions, so fall
    // back to the design's dummy dataset. import.meta.env.DEV is false
    // in every production build — prod failures land in the empty state.
    if (import.meta.env.DEV) {
      const { SAMPLE, SAMPLE_TESTIMONIALS } = await import("./sample-data.js");
      if (!TESTIMONIALS.length) TESTIMONIALS.push(...SAMPLE_TESTIMONIALS);
      return SAMPLE;
    }
    console.error("[reviews]", e);
    return { hasData: false };
  }
}

async function init() {
  const data = await loadData();
  if (!data?.hasData || !data.reviews?.length) {
    renderEmptyState();
    return;
  }
  renderBadge(data.meta);
  renderWall(data.reviews);
  wirePause();
}

init();
