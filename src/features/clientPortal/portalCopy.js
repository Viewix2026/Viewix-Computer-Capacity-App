// portalCopy.js — the approved client-facing voice, in one place so
// it can't drift to SaaS sludge across zones.
//
// The SERVER (api/_analyticsClientProjection.js) authors all the
// data-bound strings (every quantitative claim with metric + range +
// baseline). This file holds only the UI-side STRUCTURAL copy: zone
// titles, gathering-data fallbacks, the "what this includes" drawer,
// and the negative-state lines. Same register as the server bank —
// direct, commercial, outcome-focused, Aussie business. Never
// "cinematic", "passionate about", "best in class", never SaaS sludge,
// never internal jargon ("scored", "repeatability", rule ids,
// "confidence", "n=").

export const ZONE_TITLES = {
  header: "How your content is performing",
  winning: "What's winning",
  nextVideos: "What to make next",
  formatPlaybook: "Why it's working",
  story: "Your progress with Viewix",
  niche: "What the market is responding to",
};

// Per-zone gathering-data copy — shown when the projection marks a
// panel "gathering". Warm, never a blank box, never defensive.
export const GATHERING = {
  header: "We're collecting your first month of data — your dashboard fills in as we go.",
  winning: "We're still gathering enough posts to call your winners. Check back after your next few videos go out.",
  nextVideos: "Once we've seen a little more of your content, we'll line up the next smart videos to make.",
  formatPlaybook: "Still finding your strongest pattern — a few more posts and this sharpens up.",
  story: "Your progress strip builds as we track more of your content.",
};

// Negative-state lines — when reach is down / cadence low / no clear
// winner. Never alarmist, never "you're failing". Honest + forward.
export const NEGATIVE = {
  quietMonth: "Quieter month on reach — here's the one change worth testing.",
  noPattern: "We're still finding the strongest pattern.",
  sharperRead: "This month gave us a sharper read on what not to repeat.",
  nextTestClear: "The next test is clear.",
};

export const WHAT_THIS_INCLUDES_TITLE = "What this includes";

// One short, plain line under the header. The server supplies the
// dated version ("Updated 18 May. Based on public Instagram data we
// can access."); this is the fallback if it's somehow absent.
export const FRESHNESS_FALLBACK =
  "Based on public Instagram data we can access.";

export const SOURCE_LINK_LABEL = "See the post";
export const NEXT_TEASER_LABEL = "Next smart video";
