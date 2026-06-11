// src/reviews-site/sample-data.js
//
// DEV-ONLY design QA data — the dummy dataset from the design spec, in
// the exact API shapes. Loaded only via the import.meta.env.DEV branch
// in main.js when /api/public/reviews is unreachable (vite dev has no
// serverless functions). Never part of a production render.

const REVIEWS = [
  { authorDisplayName: "Sarah Mitchell",   rating: 5, createdAt: "2026-04-18", text: "We'd been burned by two video agencies before Viewix. The difference was obvious from the first call - they asked about our CAC and conversion targets before they asked about 'the vision'. Eight videos in and our cost per lead from Meta is down 38%. They just get that the video is the means, not the end." },
  { authorDisplayName: "Daniel Nguyen",    rating: 5, createdAt: "2026-04-02", text: "Fast, sharp, zero hand-holding required. Scripts arrived ready to shoot, the shoot day ran to the minute, and the cuts came back before deadline. Rare." },
  { authorDisplayName: "Priya Raman",      rating: 5, createdAt: "2026-03-27", text: "The pre-production process alone is worth it. They scraped our channel, told us exactly why our content wasn't moving, and rebuilt our format mix from the data up. First month posting their stuff: 3x our median views. We've signed for the year." },
  { authorDisplayName: "Tom Castellaro",   rating: 5, createdAt: "2026-03-15", text: "Booked them for a one-off brand film, stayed for the monthly retainer. The portal they give you to review cuts is better than tools I've paid for." },
  { authorDisplayName: "Jessica Wei",      rating: 5, createdAt: "2026-03-08", text: "As a marketing team of one, I needed an agency that didn't need managing. Viewix runs the whole pipeline - scripts, shoot, edits, even tells me what to post next and why. My CMO thinks I've hired three people." },
  { authorDisplayName: "Marcus Oliveri",   rating: 5, createdAt: "2026-02-22", text: "Straight shooters. They told us our idea for the campaign wouldn't perform and showed us the numbers on why. The alternative they pitched did 4x what our previous best video did. That conversation paid for the whole engagement." },
  { authorDisplayName: "Hannah Bourke",    rating: 5, createdAt: "2026-02-14", text: "Two rounds of revisions included and we barely needed one. The first cuts were that close. Editing quality is genuinely a level above what we got elsewhere - hooks land in the first two seconds, captions are clean, pacing is tight." },
  { authorDisplayName: "Raj Patel",        rating: 5, createdAt: "2026-02-03", text: "Their ads packages are the real deal. Same footage, nine variants, every aspect ratio - plugged straight into Meta Ads Manager. ROAS went from 2.1 to 3.4 inside six weeks. The variant testing matrix they hand over is something our media buyer still talks about." },
  { authorDisplayName: "Chloe Anderson",   rating: 5, createdAt: "2026-01-28", text: "Professional from kickoff to delivery. Weekly updates without asking, a clear portal showing exactly where every video sits, and an account manager who actually answers the phone." },
  { authorDisplayName: "Ben Tran",         rating: 5, createdAt: "2026-01-19", text: "We make industrial equipment. Not exactly TikTok material, we thought. Viewix found the angle - our fitters, the workshop, the weird satisfying machinery shots - and now our hiring pipeline is full and sales calls open with 'saw your videos'. Did not see that coming." },
  { authorDisplayName: "Lucy Hargreaves",  rating: 5, createdAt: "2026-01-08", text: "Shoot days are run like a production line, in a good way. Call sheet ahead of time, every setup pre-planned, talent prepped. We got 14 usable videos out of one day." },
  { authorDisplayName: "Andrew Kospetas",  rating: 5, createdAt: "2025-12-18", text: "Worked with them across two companies now. Both times the same: clear pricing, no scope surprises, content that performs. The monthly analytics read they send is written in plain English - what won, why, and what to make next. Board-ready without edits." },
  { authorDisplayName: "Mei Lin Chang",    rating: 5, createdAt: "2025-12-05", text: "Responsive, organised, and the work speaks for itself. Our launch videos cleared a million combined views organically. No paid push." },
  { authorDisplayName: "Oliver Whitfield", rating: 5, createdAt: "2025-11-22", text: "What sold me: they turn down work that isn't a fit. We came in asking for a corporate explainer and they redirected us to a cheaper format that suited the goal better. Agencies that leave money on the table to get the outcome right are the ones you keep." },
  { authorDisplayName: "Georgia Pappas",   rating: 5, createdAt: "2025-11-10", text: "Six months in: every deadline hit, every video approved within two rounds, engagement up across the board. The team feels like an extension of ours rather than a vendor. Couldn't recommend more highly." },
];

export const SAMPLE_TESTIMONIALS = [
  { provider: "youtube", videoId: "dQw4w9WgXcQ", clientName: "Clayton Utz",    title: "Quarterly shoot-day program",       aspect: "16:9" },
  { provider: "youtube", videoId: "oHg5SJYRHA0", clientName: "Hola Health",    title: "Founder series - 12 videos",        aspect: "9:16" },
  { provider: "youtube", videoId: "ScMzIvxBSi4", clientName: "Chickanji",      title: "Viral focused package - 16 videos", aspect: "9:16" },
  { provider: "youtube", videoId: "jNQXAC9IVRw", clientName: "Solace Beauty",  title: "Product launch campaign",           aspect: "16:9" },
  { provider: "youtube", videoId: "9bZkp7q19f0", clientName: "Meridian Legal", title: "Partner profile series",            aspect: "16:9" },
  { provider: "youtube", videoId: "kJQP7kiw5Fk", clientName: "NorthSide Gyms", title: "Member stories - 8 videos",         aspect: "9:16" },
];

export const SAMPLE = {
  hasData: true,
  meta: {
    rating: Number((REVIEWS.reduce((a, r) => a + r.rating, 0) / REVIEWS.length).toFixed(1)),
    count: REVIEWS.length,
    lastSyncAt: "2026-06-11T00:00:00.000Z",
  },
  reviews: REVIEWS,
};
