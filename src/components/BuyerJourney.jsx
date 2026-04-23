// Buyer Journey — renders the visual left-to-right customer pipeline plus
// an embedded Turnaround editor (both share the same time-between-stages
// data where a stage has been linked to a post-sale milestone).
//
// Top-level tab toggle (Journey / Turnaround) sits at the component head.
// The Journey view scrolls horizontally with no wrap — one long row of
// stage cards with connector arrows between them. Each connector shows
// the days-to-next-stage + % progression:
//   - days: pulled from /turnaround[milestoneKey] when the stage is linked,
//           otherwise the stage's own daysToNext field.
//   - %:    computed live from /accounts milestone data where both sides
//           of the gap are linked milestones; falls back to the stage's
//           manual pct text otherwise.
//
// The Turnaround sub-tab is the canonical editor for /turnaround — the
// same gap values AccountsDashboard uses to compute per-client milestone
// due dates. Edits in either place write back to the same Firebase path.

import { useState } from "react";
import { BTN, MILESTONE_DEFS, DEFAULT_MILESTONE_GAPS } from "../config";

const SECTION_COLORS = {
  "Lead Generation": "#0082FA",
  "Lead Generation — Funnels": "#0082FA",
  "Sales": "#F87700",
  "Sales — Discovery & Blueprint": "#F87700",
  "Sale Conversion": "#F59E0B",
  "Pre Production": "#8B5CF6",
  "Pre-Production": "#8B5CF6",
  "Production": "#10B981",
  "Editing & Review": "#14B8A6",
  "Delivery": "#F59E0B",
  "Delivery & Feedback": "#F59E0B",
  "Upload & Scheduling (Social Retainer)": "#0EA5E9",
  "Performance & Review": "#EC4899",
  "Renewal": "#EC4899",
  "Retention": "#EC4899",
  "Loop — Renewed back to Pre-Production": "#8B5CF6",
};

// ─── Event types ────────────────────────────────────────────────────
// Each stage / branch side can carry an `eventType` that colour-codes
// the card's left accent bar + tag chip so founders can scan the
// journey and see, at a glance, "who does what" at every step.
//
//   touchpoint — the client sees / experiences it (ads, emails, pages, videos)
//   action     — the client does it (clicks, pays, books, gives feedback)
//   internal   — internal team work (production, editing, QA)
//   automation — system-triggered event (nurture sequences, reminders, Slack notifs, dashboard population)
//   invoice    — money events (deposit, invoice generation)
//   meeting    — scheduled live meetings (discovery call, pre-prod, SRM, SPM)
//   notBuilt   — documented but not yet implemented — amber dashed border
const EVENT_TYPES = {
  touchpoint: { label: "Client touchpoint",  color: "#0082FA", icon: "👁" },
  action:     { label: "Client action",      color: "#10B981", icon: "✓" },
  internal:   { label: "Internal task",      color: "#8B5CF6", icon: "⚙" },
  automation: { label: "Automation",         color: "#06B6D4", icon: "⚡" },
  invoice:    { label: "Invoice / payment",  color: "#F59E0B", icon: "$" },
  meeting:    { label: "Meeting",            color: "#EC4899", icon: "📅" },
  notBuilt:   { label: "Not yet built",      color: "#EF4444", icon: "⏳" },
};

// Milestone-to-default-stage hints used when the user first opens the
// editor — otherwise the dropdown is just "(none)" everywhere. Stored
// on the stage as `milestoneKey` once the user links it explicitly.
const DEFAULT_META = [
  { id: "m1", type: "section", label: "Lead Generation" },
  { id: "m2", type: "stage", title: "Meta ad", desc: "Prospect watches a video ad on Facebook or Instagram" },
  { id: "m3", type: "stage", title: "Click \"Learn more\"", desc: "CTA button takes them to the landing page" },
  { id: "m4", type: "stage", title: "Landing page", desc: "Complete a 5 step survey. They become a lead at this point." },
  { id: "m5", type: "stage", title: "Booked meeting", desc: "65% of leads book a meeting with the sales team. Lead is pushed to the LEADS Slack channel.", pct: "65% convert" },
  { id: "m6", type: "stage", title: "Closer calls immediately", desc: "As soon as the lead comes in, a closer calls them from the LEADS channel" },
  { id: "m7", type: "section", label: "Sales" },
  { id: "m8", type: "stage", title: "Discovery call", desc: "Further qualification. Understand their goals, budget, timeline. Present the content blueprint." },
  { id: "m9", type: "branch", left: { title: "Won", desc: "Send video sales letter explaining the process. Closer sends 50% invoice." }, right: { title: "Lost", desc: "Deal closed. Add to nurture sequence for future re-engagement." } },
  { id: "m10", type: "stage", title: "Invoice paid", desc: "First 50% invoice for their ad package is paid before production begins", diff: true, tag: "50% upfront", milestoneKey: "signing" },
  { id: "m11", type: "section", label: "Pre Production" },
  { id: "m12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business.", milestoneKey: "preProductionMeeting" },
  { id: "m13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas" },
  { id: "m14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction", milestoneKey: "preProductionPresentation" },
  { id: "m15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "m16", type: "section", label: "Production" },
  { id: "m17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team" },
  { id: "m18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location", milestoneKey: "shoot" },
  { id: "m19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios" },
  { id: "m20", type: "section", label: "Delivery" },
  { id: "m21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "m22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "m23", type: "stage", title: "Final delivery", desc: "Deliver all videos in all ratios to the client. Client shares with their ad agency for deployment.", diff: true, milestoneKey: "posting" },
  { id: "m24", type: "section", label: "Retention" },
  { id: "m25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review ad performance in Meta Ads Manager with their agency", milestoneKey: "resultsReview" },
  { id: "m26", type: "stage", title: "Ongoing catch ups", desc: "Understand which ads are performing. Identify when new ads or a video sales letter is needed to increase landing page opt in rate.", milestoneKey: "partnershipReview" },
];

// ═══════════════════════════════════════════════════════════════════
// DEFAULT_COMBINED — the FULL Viewix buyer journey, Jeremy's dictation
// turned into a colour-coded flow chart.
//
// Structure:
//   11 sections (Lead Gen → Loop)
//   ~65 stages + decision points
//   7 event types colour-coded on each stage
//   4 branches (Yes/Maybe/No/No-show + Revise/Approve + Renew/Not + etc.)
//   2 offerBranches (payment schedule + final delivery)
//   1 multiBranch for the 4 lead funnels converging
//
// Every stage can carry:
//   eventType  — touchpoint / action / internal / automation / invoice / meeting / notBuilt
//   notBuilt   — flagged stages render amber-dashed with a "⏳ Not built" tag
//   tag        — short label chip (e.g. "50 / 50", "1 day before", "Meta Ads only")
//   milestoneKey — ties to /turnaround so days-to-next syncs with AccountsDashboard
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_COMBINED = [
  // ─── LEAD GENERATION ──────────────────────────────────────────────
  { id: "c1",  type: "section", label: "Lead Generation — Funnels" },

  // Four parallel funnels, each a full path that converges on #leads Slack.
  // Rendered as a multiBranch so they sit side-by-side visually.
  { id: "c2",  type: "multiBranch", sides: [
      { eventType: "touchpoint", title: "Meta Ads Funnel",
        desc: "Prospect sees Meta ad → clicks → lands on landing page (pixel fires for retargeting) → completes 5-step survey → becomes lead." },
      { eventType: "touchpoint", title: "Instagram Funnel",
        desc: "Sees content on Instagram → DMs \"video\" → auto-reply asks for phone number → number lands in #leads Slack." },
      { eventType: "touchpoint", title: "Website Funnel",
        desc: "Visits viewix.com.au → completes Get Started form → info lands in #leads Slack." },
      { eventType: "notBuilt", notBuilt: true, title: "Lead Magnet Funnel",
        desc: "Meta ads / website tab / Instagram CTA → single lead magnet landing page → #leads Slack. 3 variants, not built yet." },
  ] },

  { id: "c3",  type: "stage", eventType: "automation", title: "Lead lands in #leads Slack",
    desc: "Phone + source visible to closers. Simultaneously triggers the lead-nurture sequence (email + SMS) to keep the lead warm." },
  { id: "c4",  type: "stage", eventType: "internal", title: "Closer calls lead immediately",
    desc: "Closer in #leads picks up as soon as the lead drops. First-response speed is the #1 predictor of booking." },
  { id: "c5",  type: "stage", eventType: "internal", title: "Walks through competitor analysis report",
    desc: "Closer presents an AI-generated competitor analysis of the prospect's industry / handles on the phone call." },
  { id: "c6",  type: "stage", eventType: "action", title: "Books discovery meeting",
    desc: "Either during the survey flow or on the closer's first call. Prospect is now scheduled for a discovery call." },

  // ─── SALES ─────────────────────────────────────────────────────────
  { id: "c7",  type: "section", label: "Sales — Discovery & Blueprint" },

  { id: "c8",  type: "stage", eventType: "automation", title: "Pre-meeting nurture sequence",
    desc: "Email + SMS sequence keeps the lead engaged and encourages show-up to the discovery call." },
  { id: "c9",  type: "stage", eventType: "automation", title: "Meeting reminder (2 hours before)",
    desc: "Auto-fires by email 2 hours before the scheduled discovery call.", tag: "2 hrs before" },
  { id: "c10", type: "stage", eventType: "meeting", title: "Discovery call — Content Blueprint",
    desc: "Closer presents the content blueprint. Deep qualification on goals, budget, timeline, fit." },

  // 4-way outcome branch
  { id: "c11", type: "multiBranch", sides: [
      { eventType: "action", title: "YES — proceed",
        desc: "Prospect commits. Closer sends the deposit page link (/s/{shortId})." },
      { eventType: "internal", title: "MAYBE — needs time",
        desc: "Closer organises catch-up meetings to nurture. Stays active in the pipeline." },
      { eventType: "notBuilt", notBuilt: true, title: "NO — declined",
        desc: "Prospect passes. Drops into a longer-term nurture sequence. Not built yet." },
      { eventType: "notBuilt", notBuilt: true, title: "NO-SHOW",
        desc: "Didn't attend the discovery call. Kicks off a re-engagement nurture sequence. Not built yet." },
  ] },

  // ─── SALE CONVERSION ──────────────────────────────────────────────
  { id: "c12", type: "section", label: "Sale Conversion" },

  { id: "c13", type: "stage", eventType: "touchpoint", title: "Deposit page link sent",
    desc: "Closer emails + SMSes the Stripe deposit link. Branded Viewix page with scope, schedule, consent, and the Stripe Embedded Checkout iframe." },
  { id: "c14", type: "stage", eventType: "invoice", title: "Deposit paid",
    desc: "Prospect pays on the public payment page. Stripe webhook fires → marks slice 0 paid + saves payment method for future charges.",
    milestoneKey: "signing" },

  // Payment schedule divergence (Meta Ads vs Social)
  { id: "c15", type: "offerBranch", milestoneKey: "signing",
    metaAds:        { title: "50 / 50 schedule", desc: "50% upfront (paid now) + 50% balance charged on project completion via the Charge Balance button in the Sale tab.", tag: "50 / 50" },
    socialRetainer: { title: "3-payment schedule", desc: "Deposit now + auto-charge at +30 days + auto-charge at +60 days (Stripe subscription).", tag: "3 payments" } },

  { id: "c16", type: "stage", eventType: "touchpoint", title: "Well Done page",
    desc: "Branded confirmation page (paper-cream Studio design). Loom video specific to the package purchased. Producer card with photo. TidyCal embed for pre-production booking. Receipt + Download receipt button.",
    tag: "was Thank-You page" },
  { id: "c17", type: "stage", eventType: "automation", title: "Slack #sales: deposit received",
    desc: "Auto-posted to #sales channel with deposit amount, client name, package tier, LTV forecast." },
  { id: "c18", type: "stage", eventType: "internal", title: "Log sale in Attio",
    desc: "Closer manually records the won deal in Attio. Triggers every downstream automation via the deal-won webhook." },

  // Parallel post-sale automations (multiBranch because they all fire together)
  { id: "c19", type: "multiBranch", sides: [
      { eventType: "automation", title: "Monday project task",
        desc: "Auto-created in the production board (1884080816). Assigned to producer." },
      { eventType: "automation", title: "Xero invoice generated",
        desc: "Invoice raised for accounting. Matches Stripe payment on reconciliation." },
      { eventType: "automation", title: "Dashboard populated",
        desc: "Creates: Projects tab record, Accounts tab entry, Deliveries page (empty), Client Sherpa." },
      { eventType: "notBuilt", notBuilt: true, title: "Assign account manager + producer",
        desc: "Currently manual — founder picks. Needs a routing rule (capacity-aware). Not built yet." },
  ] },

  // ─── PRE-PRODUCTION ───────────────────────────────────────────────
  { id: "c20", type: "section", label: "Pre-Production" },

  { id: "c21", type: "stage", eventType: "action", title: "Client books pre-production call",
    desc: "TidyCal embed on Well Done page → scheduled into Vish's (production manager) calendar." },
  { id: "c22", type: "stage", eventType: "automation", title: "Reminder emails",
    desc: "Two auto-reminders: one the day before the meeting, one an hour before.",
    tag: "24h + 1h" },
  { id: "c23", type: "stage", eventType: "meeting", title: "Pre-production meeting",
    desc: "Vish + account manager + client. AI notetaker records. Questions on goals, aspirations, fears, desires, USP, industry — what's changed since last time for repeat clients.",
    milestoneKey: "preProductionMeeting" },
  { id: "c24", type: "stage", eventType: "automation", title: "Transcription → Google Doc → #preproduction Slack",
    desc: "AI notetaker output lands in both places automatically. Producer reads before building the brief." },
  { id: "c25", type: "stage", eventType: "internal", title: "Schedule pre-production presentation",
    desc: "Scheduled within ~7 days of the first meeting.",
    tag: "+7 days" },
  { id: "c26", type: "stage", eventType: "internal", title: "Production manager assigns producer",
    desc: "Production manager picks the right producer for this project." },

  // Pre-production workflow divergence (Meta Ads 6-tab vs Social Organic 8-tab)
  { id: "c27", type: "offerBranch",
    metaAds:        { title: "Meta Ads pre-production", desc: "Producer runs the 6-tab flow in the dashboard: Brand Truth → Ad Library → Video Review → Shortlist → Selection → Scripting." },
    socialRetainer: { title: "Social Organic pre-production", desc: "Producer runs the 8-tab flow: Brand Truth → Format Research → Client Research → Video Review → Shortlist → Format Selection → Idea Selection → Scripting." } },

  { id: "c28", type: "stage", eventType: "internal", title: "Internal pre-prod review",
    desc: "Producer + account manager review together before showing the client. Catches anything off-brief." },
  { id: "c29", type: "stage", eventType: "meeting", title: "Pre-production presentation",
    desc: "Producer + account manager + client. Google Meet or in-person (Dulwich Hill office). Walk client through all creative ideas.",
    milestoneKey: "preProductionPresentation" },
  { id: "c30", type: "branch",
    left:  { title: "Revisions requested", desc: "Producer updates the brief. Schedule another pre-production presentation." },
    right: { title: "Approved", desc: "Shoot date booked. Edit date(s) scheduled for one or more editors to meet the client's timeline." } },
  { id: "c31", type: "stage", eventType: "automation", title: "Video names + run sheet scaffolding populated",
    desc: "Once pre-prod is approved: deliveries page pre-fills with video names, run sheet is pre-scaffolded so the producer just fills the blanks." },
  { id: "c32", type: "stage", eventType: "internal", title: "Producer finalises run sheet",
    desc: "Fills in full shoot details — call times, locations, talent, wardrobe, shot list, props." },
  { id: "c33", type: "stage", eventType: "touchpoint", title: "Run sheet emailed to client",
    desc: "Production manager sends the finalised run sheet to the client. Chance for any last-minute flags." },

  // ─── PRODUCTION ───────────────────────────────────────────────────
  { id: "c34", type: "section", label: "Production" },

  { id: "c35", type: "stage", eventType: "automation", title: "Pre-shoot email (day before)",
    desc: "Auto-fires the day before. Excitement + pre-shoot talent checklist so the client knows exactly what to prepare.",
    tag: "1 day before" },
  { id: "c36", type: "stage", eventType: "meeting", title: "Shoot day",
    desc: "Full team on-site. Everything from the run sheet is captured.",
    milestoneKey: "shoot" },
  { id: "c37", type: "stage", eventType: "internal", title: "Shooter creates project folder + drops footage",
    desc: "All raw footage uploaded to the project's Drive folder." },
  { id: "c38", type: "stage", eventType: "automation", title: "Edit Suite email to client",
    desc: "Auto-fires letting the client know we're in post. Expect an update soon.",
    tag: "+1 day after shoot" },

  // ─── EDITING & REVIEW ─────────────────────────────────────────────
  { id: "c39", type: "section", label: "Editing & Review" },

  { id: "c40", type: "stage", eventType: "internal", title: "Producer makes selects timeline",
    desc: "Initial cut selects — narrows hundreds of raw clips down to the usable takes for each video." },
  { id: "c41", type: "stage", eventType: "internal", title: "Edit kick-off walkthrough (Loom or OBS)",
    desc: "Project lead records a screen walkthrough — brief, shoot context, format specifics. Uploaded to Drive + linked on the project so every editor (sync or async) sees exactly what the project looks like." },
  { id: "c42", type: "stage", eventType: "internal", title: "Editors edit all videos",
    desc: "Full editorial work per video. Every format + every aspect ratio variant." },
  { id: "c43", type: "stage", eventType: "internal", title: "Producer quality review",
    desc: "QA pass against the brief. Nothing advances until the producer signs off." },
  { id: "c44", type: "stage", eventType: "internal", title: "Account manager review",
    desc: "Second QA layer. Approved on #slack before the deliveries page exposes anything to the client." },
  { id: "c45", type: "stage", eventType: "internal", title: "Push links to deliveries page",
    desc: "Production manager manually uploads Frame.io links into the dashboard. Should be automated — wire Frame.io webhook directly into the deliveries page.",
    tag: "manual now, automate later" },

  // ─── DELIVERY & FEEDBACK ──────────────────────────────────────────
  { id: "c46", type: "section", label: "Delivery & Feedback" },

  { id: "c47", type: "stage", eventType: "touchpoint", title: "Deliveries page shared with client",
    desc: "Client-branded public share link (/d/{shortId}). Two rounds of revisions included.",
    milestoneKey: "posting" },
  { id: "c48", type: "stage", eventType: "action", title: "Client reviews + leaves feedback",
    desc: "Detailed per-video notes in Frame.io + per-video Approved / Needs Revision status on the deliveries page." },
  { id: "c49", type: "branch",
    left:  { title: "Revisions", desc: "Producer actions changes. Back to review. Up to 2 rounds included." },
    right: { title: "All approved", desc: "Move to upload / hand-off phase." } },

  // ─── UPLOAD & SCHEDULING ─────────────────────────────────────────
  // This phase diverges: Meta Ads → client's agency takes over.
  // Social Retainer → Viewix uploads + schedules + boosts.
  { id: "c50", type: "section", label: "Upload & Scheduling (Social Retainer)" },

  { id: "c51", type: "offerBranch",
    metaAds:        { title: "Final delivery", desc: "Deliver all videos in all ratios. Client hands off to their ad agency for Meta Ads deployment. Viewix's production phase ends here." },
    socialRetainer: { title: "Upload + schedule (Metricool)", desc: "Production manager uploads videos + schedules them via Metricool using client's credentials. First month: one video per format, best first." } },

  { id: "c52", type: "stage", eventType: "automation", title: "Auto-schedule 6 meetings",
    desc: "Social Retainer only. 3× SRM (Social Review Meeting, with client + AM + producer) and 3× SPM (Social Performance Meeting, internal-only). SPM always 2 hours before its paired SRM. SPM learnings feed the Sherpa." },
  { id: "c53", type: "stage", eventType: "internal", title: "$5 boost per post on Instagram",
    desc: "Every uploaded video gets a standard $5 Instagram boost for broad reach + to surface the low-cost-per-profile-visit winners." },

  // ─── PERFORMANCE & REVIEW ─────────────────────────────────────────
  { id: "c54", type: "section", label: "Performance & Review (Social Retainer)" },

  { id: "c55", type: "stage", eventType: "meeting", title: "SPM 1 (week ~4, internal)",
    desc: "Producer + AM review initial analytics before the client meeting. Identifies what to pitch." },
  { id: "c56", type: "stage", eventType: "meeting", title: "SRM 1 (week 4, with client)",
    desc: "Review initial 4-week analytics. Identify the 2 highest-performing videos + add $50 boost each. Discuss what formats are working.",
    milestoneKey: "resultsReview",
    tag: "+4 weeks" },
  { id: "c57", type: "stage", eventType: "internal", title: "Round 2 pre-production kickoff",
    desc: "Producer scheduled to kick off R2 content pre-production, 1 week before SRM 2.",
    tag: "+7 weeks" },
  { id: "c58", type: "stage", eventType: "meeting", title: "SPM 2 (week ~8, internal)",
    desc: "Pre-SRM 2 analytics review + pitch prep." },
  { id: "c59", type: "stage", eventType: "meeting", title: "SRM 2 (week 8, with client)",
    desc: "Analytics + pitch R2 content ideas. Identify top 2 from month 2 + add $50 boost each.",
    tag: "+8 weeks" },

  // ─── RENEWAL ─────────────────────────────────────────────────────
  { id: "c60", type: "section", label: "Renewal" },

  { id: "c61", type: "branch",
    left:  { title: "Renew YES", desc: "Client signs for another round. New shoot date booked. Run sheet begins. Loop back to Pre-Production (c20)." },
    right: { title: "Renew NO", desc: "Move into SRM 3 last-ditch pitch." } },
  { id: "c62", type: "stage", eventType: "meeting", title: "SPM 3 (week ~12, internal)",
    desc: "Pre-SRM 3 analytics + last-pitch strategy. What can we offer to win them back?" },
  { id: "c63", type: "stage", eventType: "meeting", title: "SRM 3 — last-pitch (week 12, with client)",
    desc: "Final analytics wrap. New lead magnet pitched (e.g. competitor analysis). $200 / month discount offered.",
    tag: "+12 weeks" },
  { id: "c64", type: "branch",
    left:  { title: "Recovered at SRM 3", desc: "Client renews after the last-pitch. Loop back to Pre-Production." },
    right: { title: "Still no — churn", desc: "Client churns. Drop into the 6-month retention nurture." } },

  { id: "c65", type: "stage", eventType: "notBuilt", notBuilt: true, title: "6-month retention nurture",
    desc: "Mix of email + SMS over 6 months post-churn. Goal: win back when their needs shift. NOT YET BUILT." },

  // ─── LOOP (renewed path) ─────────────────────────────────────────
  { id: "c66", type: "section", label: "Loop — Renewed back to Pre-Production" },
  { id: "c67", type: "stage", eventType: "internal", title: "Restart production cycle",
    desc: "New shoot date. Run sheet. Production begins again. Repeat as many cycles as the client keeps renewing — this is where LTV compounds." },
];

const DEFAULT_SOCIAL = [
  { id: "s1", type: "section", label: "Lead Generation" },
  { id: "s2", type: "stage", title: "Meta ad", desc: "Prospect watches a video ad on Facebook or Instagram" },
  { id: "s3", type: "stage", title: "Click \"Learn more\"", desc: "CTA button takes them to the landing page" },
  { id: "s4", type: "stage", title: "Landing page", desc: "Complete a 5 step survey. They become a lead at this point." },
  { id: "s5", type: "stage", title: "Booked meeting", desc: "65% of leads book a meeting with the sales team. Lead is pushed to the LEADS Slack channel.", pct: "65% convert" },
  { id: "s6", type: "stage", title: "Closer calls immediately", desc: "As soon as the lead comes in, a closer calls them from the LEADS channel" },
  { id: "s7", type: "section", label: "Sales" },
  { id: "s8", type: "stage", title: "Discovery call", desc: "Further qualification. Understand their goals, budget, timeline. Present the content blueprint." },
  { id: "s9", type: "branch", left: { title: "Won", desc: "Send video sales letter explaining the process. Closer sends first invoice." }, right: { title: "Lost", desc: "Deal closed. Add to nurture sequence for future re-engagement." } },
  { id: "s10", type: "stage", title: "Invoice paid", desc: "Retainer split into 3 invoices. First paid upfront, second after that, third paid one month after the second.", diff: true, tag: "3 payments", milestoneKey: "signing" },
  { id: "s11", type: "section", label: "Pre Production" },
  { id: "s12", type: "stage", title: "Pre production meeting", desc: "Client meets a founder and their project lead. Project lead asks questions to deeply understand the business.", milestoneKey: "preProductionMeeting" },
  { id: "s13", type: "stage", title: "Pre production prep", desc: "Team puts together the pre production plan with all creative ideas" },
  { id: "s14", type: "stage", title: "Pre production call", desc: "Run the client through all ideas and creative direction", milestoneKey: "preProductionPresentation" },
  { id: "s15", type: "branch", left: { title: "Revisions", desc: "Client has feedback. A couple of days to action, then another meeting to confirm." }, right: { title: "Approved", desc: "No changes needed. Go straight to booking the shoot." } },
  { id: "s16", type: "section", label: "Production" },
  { id: "s17", type: "stage", title: "Book shoot", desc: "Schedule the shoot date with the client and team" },
  { id: "s18", type: "stage", title: "Shoot day", desc: "Single shoot day with the full team on location", milestoneKey: "shoot" },
  { id: "s19", type: "stage", title: "Editing", desc: "Editor completes all videos and all aspect ratios" },
  { id: "s20", type: "section", label: "Delivery" },
  { id: "s21", type: "branch", left: { title: "Office review", desc: "Client comes in to review. Get a video testimonial and take feedback in person." }, right: { title: "Frame.io", desc: "Client reviews videos online via Frame.io and leaves feedback there." } },
  { id: "s22", type: "stage", title: "Action feedback", desc: "Make any requested changes from the review" },
  { id: "s23", type: "stage", title: "Upload to Metricool", desc: "Viewix takes the client's login credentials and uploads content directly to Metricool, scheduling and posting for them.", diff: true, milestoneKey: "posting" },
  { id: "s24", type: "section", label: "Retention" },
  { id: "s25", type: "stage", title: "Monthly performance review", desc: "Recurring monthly meeting to review content performance and engagement metrics", milestoneKey: "resultsReview" },
  { id: "s26", type: "stage", title: "Ongoing catch ups", desc: "Understand what content is performing. Identify when a new batch of content is needed for the next month.", milestoneKey: "partnershipReview" },
];

// Title-based fallback for auto-linking stages to milestones when the
// user's /buyerJourney data predates the milestoneKey field. Matches
// are substring and case-insensitive so renamed stages still link as
// long as the core phrase is present ("Pre-Prod Meeting", "pre prod
// kickoff", etc. all match).
//
// Order matters: more specific patterns appear first. "pre prod
// presentation" beats "pre prod" which would otherwise grab everything.
// Producers can override by picking "(none)" in edit mode — stored as
// explicit milestoneKey: null, which wins over this derivation.
const TITLE_TO_MILESTONE = [
  // Specific phrases first
  { match: ["pre prod presentation", "pre-production presentation", "pre production presentation",
            "pre prod call", "pre-production call", "pre production call",
            "blueprint call", "content blueprint"],                   key: "preProductionPresentation" },
  { match: ["pre prod meeting", "pre-production meeting", "pre production meeting",
            "kickoff meeting", "kickoff call", "kick off meeting"],   key: "preProductionMeeting" },
  { match: ["invoice paid", "deposit paid", "first invoice", "signing"], key: "signing" },
  { match: ["shoot day", "shooting day", "shoot date", "production day"], key: "shoot" },
  { match: ["final delivery", "upload to metricool", "posting", "go live", "campaign live"], key: "posting" },
  { match: ["monthly performance review", "results review",
            "performance review", "monthly review", "review call"],   key: "resultsReview" },
  { match: ["ongoing catch", "partnership review", "quarterly review"], key: "partnershipReview" },
  { match: ["growth strategy", "growth plan", "strategy session"],    key: "growthStrategy" },
];
function deriveMilestoneKey(stage) {
  // Explicit null wins (producer unlinked). Explicit string wins too.
  if (stage?.milestoneKey !== undefined) return stage.milestoneKey || null;
  // OfferBranch items may carry their key on the parent OR on the meta/
  // socialRetainer sub-object — check both. Parent-level wins (both
  // offers share the same milestone so linking applies to both).
  if (stage?.type === "offerBranch") {
    const k = stage.metaAds?.milestoneKey || stage.socialRetainer?.milestoneKey;
    if (k !== undefined) return k || null;
  }
  const title = (stage?.title || stage?.metaAds?.title || stage?.socialRetainer?.title || "").toLowerCase().trim();
  if (!title) return null;
  // Substring match — covers renames like "Pre-Prod Meeting" or
  // "Kickoff call" without needing the exact default wording.
  const match = TITLE_TO_MILESTONE.find(m => m.match.some(t => title.includes(t)));
  return match?.key || null;
}

// Convert a stage + turnaround-gap map to a display-ready days value.
// Milestone-linked stages pull from /turnaround (editing them there
// writes back to /turnaround); unlinked stages store their own days
// on the stage object. Returns null when no value is set either way.
function getDaysToNext(stage, turnaround) {
  const mk = deriveMilestoneKey(stage);
  if (mk) {
    const v = turnaround?.[mk];
    return v != null ? Number(v) : null;
  }
  if (stage?.daysToNext != null) return Number(stage.daysToNext);
  return null;
}

// Compute live conversion % from accounts data — what fraction of clients
// that completed `fromKey` also completed `toKey`. Skips gracefully when
// either milestone isn't linked on the surrounding stages, or when we
// have too few data points to be meaningful.
function computeLivePct(accounts, fromKey, toKey) {
  if (!fromKey || !toKey || !accounts) return null;
  const list = Object.values(accounts).filter(a => a && a.id);
  if (list.length === 0) return null;
  const fromDone = list.filter(a => a?.milestones?.[fromKey]?.status === "Completed");
  if (fromDone.length < 2) return null; // too few to bother showing
  const toDone = fromDone.filter(a => a?.milestones?.[toKey]?.status === "Completed");
  return Math.round((toDone.length / fromDone.length) * 100);
}

// Find the next linkable milestone after the stage at `stages[idx]`.
// Used by computeLivePct so we pair each linked stage with the
// soonest downstream linked stage — inline sections/branches don't
// break the chain. offerBranches count too (they carry milestoneKey).
function findNextMilestoneStage(stages, idx) {
  for (let j = idx + 1; j < stages.length; j++) {
    const t = stages[j].type;
    if ((t === "stage" || t === "offerBranch") && deriveMilestoneKey(stages[j])) return stages[j];
  }
  return null;
}

export function BuyerJourney({ data, onChange, turnaround, setTurnaround, accounts }) {
  const [subTab, setSubTab] = useState("journey");      // journey | turnaround
  const [editingId, setEditingId] = useState(null);
  // Inline connector editing — { stageId, field: "days" | "pct" } | null.
  // When set, the corresponding connector label renders an input instead
  // of the static pill. Blur or Enter writes + closes. Linked stages
  // can still inline-edit days (it flows to /turnaround), but pct for
  // linked stages stays read-only live data.
  const [inlineEdit, setInlineEdit] = useState(null);

  // Unified Meta Ads + Social Retainer journey. The old per-offer toggle
  // is gone — at the 4 divergence points the renderer shows an
  // offerBranch with both offers stacked. Legacy data.meta and data.social
  // are preserved in Firebase for auditability but no longer drive the UI.
  const stages = data?.combined?.length > 0 ? data.combined : DEFAULT_COMBINED;

  const save = (updated) => { onChange({ ...data, combined: updated }); };
  const updateItem = (id, patch) => { save(stages.map(s => s.id === id ? { ...s, ...patch } : s)); };
  const removeItem = (id) => { if (!confirm("Remove this item?")) return; save(stages.filter(s => s.id !== id)); };
  const moveItem = (id, dir) => { const idx = stages.findIndex(s => s.id === id); if (idx < 0) return; const si = idx + dir; if (si < 0 || si >= stages.length) return; const n = [...stages]; [n[idx], n[si]] = [n[si], n[idx]]; save(n); };

  const addStage = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const nid = `c${Date.now()}`; const n = [...stages]; n.splice(idx + 1, 0, { id: nid, type: "stage", title: "New stage", desc: "" }); save(n); setEditingId(nid); };
  const addBranch = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const nid = `cb${Date.now()}`; const n = [...stages]; n.splice(idx + 1, 0, { id: nid, type: "branch", left: { title: "Option A", desc: "" }, right: { title: "Option B", desc: "" } }); save(n); setEditingId(nid); };
  const addSection = (afterId) => { const idx = stages.findIndex(s => s.id === afterId); const n = [...stages]; n.splice(idx + 1, 0, { id: `csec${Date.now()}`, type: "section", label: "New Section" }); save(n); };

  // Edit handler for per-stage days: linked stages push to /turnaround,
  // unlinked stages persist on the stage itself. Empty string clears.
  const updateStageDays = (stage, value) => {
    const num = value === "" || value == null ? null : Number(value);
    const mk = deriveMilestoneKey(stage);
    if (mk) {
      setTurnaround(prev => ({ ...(prev || {}), [mk]: num ?? 0 }));
    } else {
      updateItem(stage.id, { daysToNext: num });
    }
  };

  const inputSt = { width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13, outline: "none", fontFamily: "'DM Sans',sans-serif" };
  const descSt = { ...inputSt, fontSize: 12, minHeight: 50, resize: "vertical" };
  const smallBtn = { background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 10, padding: "2px 4px" };

  // Enhanced connector between two stages — shows days-to-next and
  // optional % conversion stacked above the arrow. Both chips click-to-
  // edit: click days → numeric input; click pct → text input (unless
  // the pct is computed live from accounts data, in which case the pill
  // is read-only and shows a tooltip explaining why).
  const StageConnector = ({ stage, days, pctValue, pctSource }) => {
    const hasDays = days != null && !isNaN(days);
    const hasPct = pctValue != null && pctValue !== "";
    const daysEditing = inlineEdit?.stageId === stage?.id && inlineEdit?.field === "days";
    const pctEditing  = inlineEdit?.stageId === stage?.id && inlineEdit?.field === "pct";
    const canEditPct = pctSource !== "live"; // live % is derived — not editable
    const pctBgColor = pctSource === "live" ? "rgba(16,185,129,0.12)" : "rgba(0,130,250,0.12)";
    const pctFgColor = pctSource === "live" ? "#10B981" : "#0082FA";
    const pctTitle = pctSource === "live"
      ? "Live conversion from client milestone data (auto-computed — link/unlink milestones on the stages to change)"
      : (canEditPct ? "Click to edit manual % label" : "");

    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "center", flexShrink: 0, gap: 2, padding: "0 6px", minWidth: 70 }}>
        {/* Percent pill (above arrow). Empty-state click-to-add when
            nothing is set but the stage is unlinked — gives producers
            a fast way to drop a "~30%" note without entering edit mode. */}
        {pctEditing ? (
          <input autoFocus type="text"
            defaultValue={typeof pctValue === "number" ? `${pctValue}%` : (pctValue || "")}
            onBlur={e => { updateItem(stage.id, { pct: e.target.value.trim() }); setInlineEdit(null); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); }}
            placeholder="e.g. 65%"
            style={{ width: 70, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }}
          />
        ) : hasPct ? (
          <div
            onClick={() => { if (canEditPct) setInlineEdit({ stageId: stage.id, field: "pct" }); }}
            title={pctTitle}
            style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: pctBgColor, color: pctFgColor, whiteSpace: "nowrap", fontFamily: "'JetBrains Mono',monospace", cursor: canEditPct ? "pointer" : "help" }}>
            {typeof pctValue === "number" ? `${pctValue}%` : pctValue}
            {pctSource === "live" && <span style={{ marginLeft: 4, opacity: 0.6 }}>●</span>}
          </div>
        ) : (stage && canEditPct) ? (
          <button
            onClick={() => setInlineEdit({ stageId: stage.id, field: "pct" })}
            title="Add % conversion"
            style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "transparent", color: "var(--muted)", border: "1px dashed var(--border)", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>
            + %
          </button>
        ) : null}

        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ height: 2, width: 20, background: "var(--border)" }} />
          <div style={{ width: 0, height: 0, borderTop: "5px solid transparent", borderBottom: "5px solid transparent", borderLeft: "6px solid var(--border)" }} />
        </div>

        {/* Days chip (below arrow). Linked stages show a subtle ↻ to
            remind producers that editing here also bumps /turnaround. */}
        {daysEditing ? (
          <input autoFocus type="number" min={0}
            defaultValue={hasDays ? days : ""}
            onBlur={e => { updateStageDays(stage, e.target.value); setInlineEdit(null); }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); }}
            placeholder="days"
            style={{ width: 55, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }}
          />
        ) : hasDays ? (
          <div
            onClick={() => setInlineEdit({ stageId: stage.id, field: "days" })}
            title={deriveMilestoneKey(stage) ? "Click to edit — also writes to /turnaround (syncs with client due dates)" : "Click to edit days to next stage"}
            style={{ fontSize: 10, fontWeight: 600, color: "var(--muted)", whiteSpace: "nowrap", fontFamily: "'JetBrains Mono',monospace", cursor: "pointer", padding: "1px 4px", borderRadius: 3 }}>
            {days}d{deriveMilestoneKey(stage) && <span style={{ marginLeft: 3, opacity: 0.6, color: "#0082FA" }}>↻</span>}
          </div>
        ) : stage ? (
          <button
            onClick={() => setInlineEdit({ stageId: stage.id, field: "days" })}
            title="Add days to next stage"
            style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3, background: "transparent", color: "var(--muted)", border: "1px dashed var(--border)", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>
            + d
          </button>
        ) : null}
      </div>
    );
  };

  // ─── JOURNEY SUB-TAB ─────────────────────────────────────────────
  const renderJourneyView = () => (
    <div style={{ padding: "24px 28px 60px", overflowX: "auto" }}>
      <div style={{
        display: "flex", flexDirection: "row", flexWrap: "nowrap",
        alignItems: "stretch", gap: 8, minWidth: "min-content",
      }}>
        {stages.map((item, i) => {
          const isEditing = editingId === item.id;
          const nextItem = stages[i + 1];

          // Only render a connector when this is a regular stage that
          // advances to another stage-like thing. Sections don't get
          // connectors either side (they're the dividers).
          const showConnector = item.type !== "section" && nextItem && nextItem.type !== "section";
          // Stages AND offerBranches can carry a milestone + days-to-next.
          // Branches (won/lost, office/frame.io) don't pin a milestone —
          // they're in-flow decision points.
          const isMilestoneBearing = item.type === "stage" || item.type === "offerBranch";
          const connectorDays = isMilestoneBearing ? getDaysToNext(item, turnaround) : null;
          // Live % lookup: pair this linked item with the next linked one
          // downstream. If either end isn't linked, fall back to the
          // stage's manual pct text below.
          let pctValue = null, pctSource = null;
          if (isMilestoneBearing) {
            const itemMk = deriveMilestoneKey(item);
            const nextLinked = itemMk ? findNextMilestoneStage(stages, i) : null;
            const nextMk = nextLinked ? deriveMilestoneKey(nextLinked) : null;
            if (itemMk && nextMk) {
              const live = computeLivePct(accounts, itemMk, nextMk);
              if (live != null) { pctValue = live; pctSource = "live"; }
            }
            if (pctValue == null && item.pct) { pctValue = item.pct; pctSource = "manual"; }
          }

          if (item.type === "section") {
            const sc = SECTION_COLORS[item.label] || "var(--accent)";
            return (
              <div key={item.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, paddingLeft: i > 0 ? 8 : 0, paddingRight: 8, alignSelf: "stretch", flexShrink: 0 }}>
                {isEditing ? (
                  <input defaultValue={item.label} autoFocus onBlur={e => { updateItem(item.id, { label: e.target.value.trim() || item.label }); setEditingId(null); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                    style={{ ...inputSt, fontSize: 11, fontWeight: 700, textTransform: "uppercase", maxWidth: 140 }} />
                ) : (
                  <span onClick={() => setEditingId(item.id)}
                    style={{ fontSize: 11, fontWeight: 700, color: sc, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", writingMode: "vertical-rl", transform: "rotate(180deg)", padding: "4px 2px", whiteSpace: "nowrap" }}>
                    {item.label}
                  </span>
                )}
                <div style={{ flex: 1, width: 2, background: sc, opacity: 0.35, borderRadius: 2, minHeight: 40 }} />
                <div style={{ display: "flex", gap: 2 }}>
                  <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                  <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                  <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                </div>
              </div>
            );
          }

          // MultiBranch — 3+ side decision or parallel-path point.
          // Used for the 4 lead funnels (Meta Ads / IG / Website /
          // Lead Magnet) converging on #leads, the 4-way discovery-
          // call outcome (Yes/Maybe/No/No-show), and the 4-way
          // parallel post-sale automations (Monday task / Xero /
          // dashboard / assign). Each side can carry its own
          // eventType so the card mirrors the stage colour-coding.
          if (item.type === "multiBranch") {
            const sides = Array.isArray(item.sides) ? item.sides : [];
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                <div style={{ display: "flex", flexDirection: "column", width: 280 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {sides.map((s, sideIdx) => {
                      const et = s.eventType ? EVENT_TYPES[s.eventType] : null;
                      const isSideNotBuilt = s.eventType === "notBuilt" || s.notBuilt;
                      const sideColor = et?.color || EVENT_TYPES.touchpoint.color;
                      const sideBorder = isSideNotBuilt
                        ? `1px dashed ${EVENT_TYPES.notBuilt.color}66`
                        : `1px solid ${sideColor}55`;
                      return (
                        <div key={sideIdx} style={{ background: "var(--card)", border: sideBorder, borderRadius: 10, padding: "10px 12px", borderLeft: `3px solid ${sideColor}` }}>
                          {isEditing ? (<>
                            <input defaultValue={s.title} onBlur={e => {
                              const next = sides.map((ss, i) => i === sideIdx ? { ...ss, title: e.target.value.trim() || ss.title } : ss);
                              updateItem(item.id, { sides: next });
                            }} style={{ ...inputSt, fontSize: 12, fontWeight: 700, marginBottom: 4 }} />
                            <textarea defaultValue={s.desc} onBlur={e => {
                              const next = sides.map((ss, i) => i === sideIdx ? { ...ss, desc: e.target.value } : ss);
                              updateItem(item.id, { sides: next });
                            }} style={descSt} />
                            <select value={s.eventType || ""} onChange={e => {
                              const val = e.target.value || null;
                              const next = sides.map((ss, i) => i === sideIdx ? { ...ss, eventType: val, notBuilt: val === "notBuilt" } : ss);
                              updateItem(item.id, { sides: next });
                            }} style={{ ...inputSt, fontSize: 10, marginTop: 4 }}>
                              <option value="">(no event type)</option>
                              {Object.entries(EVENT_TYPES).map(([k, v]) => (
                                <option key={k} value={k}>{v.icon} {v.label}</option>
                              ))}
                            </select>
                          </>) : (<>
                            {(et || isSideNotBuilt) && (
                              <div style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: `${sideColor}1A`, color: sideColor, letterSpacing: "0.04em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 3, marginBottom: 4 }}>
                                <span>{(et?.icon) || EVENT_TYPES.notBuilt.icon}</span>
                                {(et?.label) || EVENT_TYPES.notBuilt.label}
                              </div>
                            )}
                            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)", marginBottom: 2 }}>{s.title}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{s.desc}</div>
                          </>)}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                </div>
                {showConnector && <StageConnector stage={item} days={connectorDays} pctValue={pctValue} pctSource={pctSource} />}
              </div>
            );
          }

          // OfferBranch — divergence point where Meta Ads and Social
          // Retainer flows differ. Renders as two stacked offer-coded
          // cards (orange Meta, purple Social) that share the same
          // milestoneKey + connector so the rest of the flow links
          // cleanly from both. Edit mode exposes both titles + descs
          // + the shared tag (e.g. "50 / 50" vs "3 payments").
          if (item.type === "offerBranch") {
            const renderOfferCard = (offerKey, offerLabel, offerColor) => {
              const o = item[offerKey] || { title: "", desc: "" };
              return (
                <div key={offerKey} style={{ background: "var(--card)", border: `1px solid ${offerColor}66`, borderRadius: 10, padding: "12px 14px", borderLeft: `3px solid ${offerColor}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: offerColor, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'JetBrains Mono',monospace" }}>
                      {offerLabel}
                    </div>
                    {o.tag && !isEditing && (
                      <div style={{ fontSize: 9, fontWeight: 700, color: offerColor, background: `${offerColor}1A`, padding: "2px 6px", borderRadius: 3, fontFamily: "'JetBrains Mono',monospace" }}>{o.tag}</div>
                    )}
                  </div>
                  {isEditing ? (<>
                    <input defaultValue={o.title} onBlur={e => updateItem(item.id, { [offerKey]: { ...o, title: e.target.value.trim() || o.title } })} style={{ ...inputSt, fontSize: 12, fontWeight: 700, marginBottom: 4 }} placeholder="Title" />
                    <textarea defaultValue={o.desc} onBlur={e => updateItem(item.id, { [offerKey]: { ...o, desc: e.target.value } })} style={descSt} placeholder="Description" />
                    <input defaultValue={o.tag || ""} onBlur={e => updateItem(item.id, { [offerKey]: { ...o, tag: e.target.value.trim() } })} style={{ ...inputSt, fontSize: 10, marginTop: 4 }} placeholder="Short tag (optional)" />
                  </>) : (<>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 2 }}>{o.title}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{o.desc}</div>
                  </>)}
                </div>
              );
            };
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                <div style={{ display: "flex", flexDirection: "column", width: 270 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {renderOfferCard("metaAds", "Meta Ads", "#F87700")}
                    {renderOfferCard("socialRetainer", "Social Retainer", "#8B5CF6")}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                  {isEditing && (
                    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <button onClick={() => addStage(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Stage</button>
                      <button onClick={() => addBranch(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Branch</button>
                      <button onClick={() => addSection(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Section</button>
                    </div>
                  )}
                </div>
                {showConnector && <StageConnector stage={item} days={getDaysToNext(item, turnaround)} pctValue={pctValue} pctSource={pctSource} />}
              </div>
            );
          }

          if (item.type === "branch") {
            return (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
                <div style={{ display: "flex", flexDirection: "column", width: 260 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {["left", "right"].map(side => {
                      const b = item[side];
                      const isWon = b.title.toLowerCase() === "won";
                      const isLost = b.title.toLowerCase() === "lost";
                      const bc = isWon ? "rgba(16,185,129,0.5)" : isLost ? "rgba(239,68,68,0.5)" : "var(--border)";
                      return (
                        <div key={side} style={{ background: "var(--card)", border: `1px solid ${bc}`, borderRadius: 10, padding: "12px 14px" }}>
                          {isEditing ? (<>
                            <input defaultValue={b.title} onBlur={e => updateItem(item.id, { [side]: { ...b, title: e.target.value.trim() || b.title } })} style={{ ...inputSt, fontSize: 12, fontWeight: 700, marginBottom: 4 }} />
                            <textarea defaultValue={b.desc} onBlur={e => updateItem(item.id, { [side]: { ...b, desc: e.target.value } })} style={descSt} />
                          </>) : (<>
                            <div style={{ fontSize: 12, fontWeight: 700, color: isWon ? "#10B981" : isLost ? "#EF4444" : "var(--fg)", marginBottom: 2 }}>{b.title}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{b.desc}</div>
                          </>)}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 4 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                  {isEditing && (
                    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <button onClick={() => addStage(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Stage</button>
                      <button onClick={() => addBranch(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Branch</button>
                      <button onClick={() => addSection(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Section</button>
                    </div>
                  )}
                </div>
                {showConnector && <StageConnector />}
              </div>
            );
          }

          // Plain stage card — colour-coded by eventType (client
          // touchpoint / action / internal / automation / invoice /
          // meeting / notBuilt). notBuilt stages render amber-dashed
          // so they're scannable as "TODO" at a glance.
          const et = item.eventType ? EVENT_TYPES[item.eventType] : null;
          const isNotBuilt = item.eventType === "notBuilt" || item.notBuilt;
          const borderColor = et?.color || (item.diff ? "var(--accent)" : "var(--border)");
          const cardBorder = isNotBuilt
            ? `1px dashed ${EVENT_TYPES.notBuilt.color}66`
            : `1px solid ${item.diff ? "var(--accent)" : "var(--border)"}`;
          return (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", width: 240 }}>
                <div style={{ background: "var(--card)", border: cardBorder, borderRadius: 10, padding: "14px 18px", borderLeft: `3px solid ${borderColor}` }}>
                  {isEditing ? (<>
                    <input defaultValue={item.title} onBlur={e => updateItem(item.id, { title: e.target.value.trim() || item.title })} style={{ ...inputSt, fontSize: 14, fontWeight: 700, marginBottom: 6 }} autoFocus />
                    <textarea defaultValue={item.desc} onBlur={e => updateItem(item.id, { desc: e.target.value })} style={descSt} />

                    {/* Milestone linker — ties this stage's days to
                        /turnaround so changes sync with the Turnaround
                        sub-tab and AccountsDashboard due dates. */}
                    <div style={{ marginTop: 8 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 }}>Linked Milestone</label>
                      {/* Pre-fills with the auto-derived milestone when no
                          explicit choice has been made, so producers see
                          "Pre Prod Meeting" already selected on a stage
                          titled "Pre production meeting". Saving from here
                          persists the choice explicitly so it wins next
                          time even if the title changes. */}
                      <select value={deriveMilestoneKey(item) || ""} onChange={e => updateItem(item.id, { milestoneKey: e.target.value || null, daysToNext: e.target.value ? null : item.daysToNext })}
                        style={{ ...inputSt, fontSize: 12 }}>
                        <option value="">(none — standalone stage)</option>
                        {MILESTONE_DEFS.map(m => (
                          <option key={m.key} value={m.key}>{m.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Per-stage time — numeric days, writes to either
                        /turnaround or the stage itself depending on link. */}
                    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em", flex: 1 }}>Days to next stage</label>
                      <input type="number" min={0}
                        defaultValue={getDaysToNext(item, turnaround) ?? ""}
                        onBlur={e => updateStageDays(item, e.target.value)}
                        style={{ ...inputSt, width: 70, fontSize: 12, textAlign: "center", fontFamily: "'JetBrains Mono',monospace" }} />
                    </div>
                    {deriveMilestoneKey(item) && (
                      <div style={{ fontSize: 10, color: "var(--accent)", marginTop: 4 }}>
                        ↻ Synced with Turnaround tab · shared with client due dates
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <input defaultValue={item.pct || ""} onBlur={e => updateItem(item.id, { pct: e.target.value.trim() })} placeholder="Manual % (e.g. 65% convert)" style={{ ...inputSt, fontSize: 11 }} />
                      <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={!!item.diff} onChange={e => updateItem(item.id, { diff: e.target.checked })} /> Differs between offers</label>
                    </div>
                  </>) : (<>
                    {/* Event-type pill (top) + milestone link icon */}
                    {(et || isNotBuilt) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: `${(et?.color) || EVENT_TYPES.notBuilt.color}1A`, color: (et?.color) || EVENT_TYPES.notBuilt.color, letterSpacing: "0.04em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span>{(et?.icon) || EVENT_TYPES.notBuilt.icon}</span>
                          {(et?.label) || EVENT_TYPES.notBuilt.label}
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)" }}>{item.title}</span>
                      {(() => {
                        const mk = deriveMilestoneKey(item);
                        if (!mk) return null;
                        return <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(0,130,250,0.12)", color: "#0082FA", letterSpacing: "0.04em" }} title={`Linked to ${MILESTONE_DEFS.find(m => m.key === mk)?.label || mk} milestone`}>↻</span>;
                      })()}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>{item.desc}</div>
                    {item.tag && (
                      <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "var(--bg)", color: "var(--muted)", display: "inline-block" }}>{item.tag}</div>
                    )}
                  </>)}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginTop: 6 }}>
                    <button onClick={() => setEditingId(isEditing ? null : item.id)} style={{ ...smallBtn, color: "var(--accent)", fontWeight: 600 }}>{isEditing ? "Done" : "Edit"}</button>
                    <button onClick={() => moveItem(item.id, -1)} style={smallBtn}>◀</button>
                    <button onClick={() => moveItem(item.id, 1)} style={smallBtn}>▶</button>
                    <button onClick={() => removeItem(item.id)} style={smallBtn}>x</button>
                  </div>
                </div>
                {isEditing && (
                  <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button onClick={() => addStage(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Stage</button>
                    <button onClick={() => addBranch(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Branch</button>
                    <button onClick={() => addSection(item.id)} style={{ ...BTN, background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 10, padding: "4px 10px" }}>+ Section</button>
                  </div>
                )}
              </div>
              {showConnector && <StageConnector stage={item} days={connectorDays} pctValue={pctValue} pctSource={pctSource} />}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── TURNAROUND SUB-TAB ─────────────────────────────────────────
  // Moved verbatim from AccountsDashboard. Reads /turnaround (merged
  // with DEFAULT_MILESTONE_GAPS for first-load bootstrap), edits write
  // back via setTurnaround. Same data as journey-view's linked stages.
  const renderTurnaroundView = () => {
    const gaps = { ...DEFAULT_MILESTONE_GAPS, ...(turnaround || {}) };
    const offsets = {};
    let cumulative = 0;
    offsets.signing = 0;
    for (let i = 1; i < MILESTONE_DEFS.length; i++) {
      const key = MILESTONE_DEFS[i].key;
      cumulative += (gaps[key] || DEFAULT_MILESTONE_GAPS[key] || 0);
      offsets[key] = cumulative;
    }
    const updateGap = (key, val) => {
      const v = parseInt(val, 10);
      if (isNaN(v) || v < 0) return;
      setTurnaround(prev => ({ ...(prev || {}), [key]: v }));
    };
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 28px 60px" }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Standard Turnaround Times</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
            Days between each post-sale milestone. These values sync to linked stages in the Journey tab and drive client milestone due-dates in Accounts.
          </div>
          <div style={{ display: "grid", gap: 0 }}>
            {MILESTONE_DEFS.slice(1).map((m, i) => {
              const prevLabel = MILESTONE_DEFS[i].label;
              return (
                <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, fontSize: 13, color: "var(--fg)" }}>{prevLabel} → {m.label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="number" value={gaps[m.key]} onChange={e => updateGap(m.key, e.target.value)} min={0} style={{ width: 48, padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", outline: "none", textAlign: "center" }} />
                    <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 28 }}>days</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {MILESTONE_DEFS.map(m => (
              <div key={m.key} style={{ padding: "4px 8px", background: "var(--bg)", borderRadius: 4, display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{m.label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", color: "var(--accent)" }}>{offsets[m.key]}d</span>
              </div>
            ))}
          </div>
        </div>

        {/* Diagnostic: which Journey stages each milestone is currently
            linked to (explicit or auto-derived). Makes it obvious when a
            stage title doesn't auto-match — producer can either rename the
            stage or use the Edit UI to link manually. */}
        <div style={{ marginTop: 20, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg)", marginBottom: 4 }}>Journey Stage Links</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
            Which stages on the Journey tab are linked to each milestone. Stages auto-link by title (fuzzy match) or explicitly via the Edit menu.
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {MILESTONE_DEFS.map(m => {
              const metaMatches = metaStages.filter(s => s.type === "stage" && deriveMilestoneKey(s) === m.key);
              const socialMatches = socialStages.filter(s => s.type === "stage" && deriveMilestoneKey(s) === m.key);
              const uniqueTitles = Array.from(new Set([...metaMatches, ...socialMatches].map(s => s.title)));
              const hasAny = uniqueTitles.length > 0;
              return (
                <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--bg)", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: hasAny ? "var(--accent)" : "#F59E0B", minWidth: 140 }}>{m.label}</div>
                  <div style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>
                    {hasAny ? uniqueTitles.map(t => `"${t}"`).join(" · ") : <em style={{ color: "#F59E0B" }}>No journey stage linked — rename a stage to include "{m.label.toLowerCase()}" or use Edit → Linked Milestone</em>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (<>
    <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--card)", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}>Buyer Journey</span>
        <div style={{ display: "flex", gap: 3, background: "var(--bg)", borderRadius: 8, padding: 3 }}>
          <button onClick={() => setSubTab("journey")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "journey" ? "var(--card)" : "transparent", color: subTab === "journey" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Journey</button>
          <button onClick={() => setSubTab("turnaround")} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: subTab === "turnaround" ? "var(--card)" : "transparent", color: subTab === "turnaround" ? "var(--fg)" : "var(--muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Turnaround</button>
        </div>
      </div>
      {subTab === "journey" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--muted)", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {Object.entries(EVENT_TYPES).map(([k, v]) => (
            <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: v.color }} />
              {v.label}
            </span>
          ))}
        </div>
      )}
    </div>
    {subTab === "journey" ? renderJourneyView() : renderTurnaroundView()}
  </>);
}
