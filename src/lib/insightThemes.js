// src/lib/insightThemes.js
// Canonical theme taxonomy for the Transcript Insights Lab.
//
// PURE DATA — zero imports, no secrets. Lives on the src/ side so the
// client bundle can never be poisoned by a server-only import creeping in;
// the api/ extraction lib and cron import it by relative path (plain ESM,
// Vercel's tracer follows it).
//
// Slugs (`key`) are STORED on /transcriptInsights/items records — they are
// permanent once classification has run. Labels are display-only and free
// to change. Blurbs are the classifier's decision rules (they go verbatim
// into the model prompt), so boundary disambiguation lives in the blurb,
// not in code.
//
// Approved at the plan gate, 2026-06-13 — see
// docs/plans/transcript-insights-themes-scope-packet.md. Per that scope
// there is deliberately NO theme-editor UI; this file is the editor.

export const OTHER_KEY = "other";
export const OTHER_LABEL = "Uncategorised";

export const THEMES = {
  objection: [
    {
      key: "money",
      label: "Money & budget",
      blurb:
        "Affordability is the blocker: bootstrapped/pre-revenue, sticker shock, budget ceilings, no budget allocated, thin margins, discount fishing, retainer-vs-one-off price confusion. If they can't fund it, it's money — even when phrased as timing ('once the launch pays for it').",
    },
    {
      key: "timing",
      label: "Not yet / no urgency",
      blurb:
        "Not now, and NOT because of affordability: offer still being built, waiting on premises/launch/return from leave, pure exploration mode, no deadline and no urgency.",
    },
    {
      key: "authority",
      label: "Someone else signs off",
      blurb:
        "The buyer on the call can't approve the spend: spouse/partner veto, CEO/board/head-office approval, silent investors, an enthusiastic gatekeeper with no power to buy.",
    },
    {
      key: "trust-proof",
      label: "Show me proof",
      blurb:
        "Wants evidence before committing: case studies, ROI proof, sector-specific examples, first-time-buyer anxiety, doubts the agency fits their vertical or product. If a NAMED rival/incumbent/alternative is in play, use competition instead.",
    },
    {
      key: "competition",
      label: "Competitors & alternatives",
      blurb:
        "A concrete alternative exists: shopping other agencies, a cheaper rival quote, an incumbent freelancer/videographer/media buyer, or DIY with AI tools. Requires an actual alternative on the table, not just a request for evidence.",
    },
    {
      key: "commitment-risk",
      label: "Commitment & risk",
      blurb:
        "Can fund it but won't lock in: contract/lock-in fear, retainer rejected in favour of a one-off test, starter-pack-first instinct, fear of sinking a full shoot into unproven messaging. If they can't fund it at all, use money.",
    },
    {
      key: "scope-fit",
      label: "Scope & fit",
      blurb:
        "Mismatch between what they want and what Viewix sells or how it delivers: wants full-stack marketing (or only filming), package confusion, single-vendor preference, production logistics friction (locations, talent, footage ownership, confidentiality).",
    },
    {
      key: "stalling",
      label: "Stalls & evasion",
      blurb:
        "The objection is the behaviour, not a stated reason: 'send me the document', 'leave it with me', vague catch-up next steps, dodging live decision calls, async-only comms.",
    },
  ],

  painPoint: [
    {
      key: "lead-flow",
      label: "Leads dried up / growth stalled",
      blurb:
        "Not enough demand: feast-or-famine pipeline, referral/word-of-mouth ceiling reached, enquiries suddenly stopped, invisible in the local market.",
    },
    {
      key: "bandwidth",
      label: "Owner has no time",
      blurb:
        "The owner or team has no capacity: owner-operator at capacity, self-filming and self-editing, can't respond to or nurture leads, content falls off whenever the business gets busy.",
    },
    {
      key: "diy-quality",
      label: "DIY content undermines the brand",
      blurb:
        "Self-made or cheap content damages a premium offer: low-fi/AI output reads cheap against the price point, fear of an embarrassing first impression at launch.",
    },
    {
      key: "ad-performance",
      label: "Paid funnel underperforming",
      blurb:
        "Paid media isn't converting: high CPL, creative fatigue, clicks without conversions, wrong-fit leads, boosting posts instead of structured campaigns, landing pages that don't convert.",
    },
    {
      key: "invisible-value",
      label: "Offer invisible or hard to explain",
      blurb:
        "The market can't see what they sell: complex intangible service, buyers don't know the full scope, USP lost in commodity comparison, distinct audiences needing different messaging.",
    },
    {
      key: "credibility-gap",
      label: "Thin online presence erodes trust",
      blurb:
        "Their digital footprint undercuts them: dormant socials, faceless brand, no testimonials, profile 'looks spun up yesterday', fails tender or credibility checks.",
    },
    {
      key: "vendor-failures",
      label: "Burned by past agencies/vendors",
      blurb:
        "Previous providers failed them: no spend transparency, wrong-audience content, technically fine but zero creative strategy, agencies refusing to do video, assets that arrived unusable.",
    },
    {
      key: "org-blockers",
      label: "Internal & regulatory blockers",
      blurb:
        "Blocked inside their own org or by regulators — can't get PERMISSION: head-office control of sites/assets, franchise budget holders, compliance review (AHPRA/ASIC/legal), fragmented stakeholders, budgets split across vendors. If the problem is proving value rather than getting permission, use measurement.",
    },
    {
      key: "deadline-pressure",
      label: "Hard deadline / launch pressure",
      blurb:
        "A fixed date compresses everything: locked events, recruitment windows, market-entry or campaign go-live dates, ad-platform learning-phase math eating the runway.",
    },
    {
      key: "measurement",
      label: "Can't measure / prove ROI",
      blurb:
        "Can't PROVE value: no conversion tracking, offline/walk-in attribution gaps, paid and organic mixed in reporting, must justify ROI upward to non-marketing directors before spend is renewed.",
    },
  ],

  contentIdea: [
    {
      key: "hooks-formats",
      label: "Hooks & creative formats",
      blurb:
        "A repeatable creative device: contrarian hooks, pattern interrupts, split screens, match cuts, named series formats, platform-specific tone and format choices.",
    },
    {
      key: "proof-stories",
      label: "Proof points & case studies",
      blurb:
        "Evidence as content: client results and metrics, before/after stories, sceptic-to-believer arcs, testimonial formulas and prompted-testimonial methods.",
    },
    {
      key: "roi-math",
      label: "ROI & funnel math",
      blurb:
        "Numbers as the persuasion device: live calculators, reverse-engineered revenue closes, LCTR/CPL benchmark explainers, 'one booking pays for itself' framings.",
    },
    {
      key: "positioning",
      label: "Viewix positioning angles",
      blurb:
        "How Viewix differentiates itself: production company vs agency, performance-marketer-who-makes-video framing, local vs offshore/AI, honest capability admissions that build trust.",
    },
    {
      key: "founder-authenticity",
      label: "Founder-led & authenticity",
      blurb:
        "People over polish: founder/expert on camera, authentic real environments beating staged ones, camera-shy workarounds, low-fi-outperforms-produced stories.",
    },
    {
      key: "education-explainers",
      label: "Education & explainers",
      blurb:
        "Teach the prospect's market: demystifying unfamiliar processes, comparison explainers, regulatory tailwinds as hooks, niche education that builds authority.",
    },
    {
      key: "sales-technique",
      label: "Closing & call techniques",
      blurb:
        "Closer behaviour worth training on: live audits as trust builders, deposit-link-on-the-call closes, urgency frames, graceful disqualification, coaching the internal champion.",
    },
    {
      key: "org-strategy",
      label: "Organic/paid strategy frameworks",
      blurb:
        "Channel strategy frameworks: organic-first sequencing, boost-and-test, post-ID social-proof carryover into ads, funnel-stage campaign structure, platform-compliance copywriting.",
    },
  ],
};

// True for a real theme of that type, or the shared OTHER_KEY.
export function validTheme(type, key) {
  if (!key || typeof key !== "string") return false;
  if (key === OTHER_KEY) return true;
  return (THEMES[type] || []).some((t) => t.key === key);
}

// Display label for a (type, key) pair; missing/other → "Uncategorised".
export function themeLabel(type, key) {
  if (!key || key === OTHER_KEY) return OTHER_LABEL;
  const t = (THEMES[type] || []).find((x) => x.key === key);
  return t ? t.label : OTHER_LABEL;
}
