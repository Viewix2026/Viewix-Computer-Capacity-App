// api/_email/templates/ReadyForReview.js
// Phase B — Refined direction, Stage 4 (Review).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[3].
//
// Trigger (post-redesign 2026-05-10): producer/AM-driven batch flow
// via api/send-review-batch.js (planned Phase A.5). Editors flag
// videos as Ready for Review through their Finish modal; producer
// then opens the project's Deliveries tab, picks one or more
// flagged videos (defaulting to all editor-flagged, with an override
// to "show all"), optionally adds a producer note, and clicks Send.
// One email per batch.
//
// Idempotency (Phase A.5): /emailLog/{projectId}/ReadyForReview/{batchId}.
//
// Subject (Jeremy to approve before live):
//   single video:  "Your video is ready for review"
//   batch of N:    "Your N videos are ready for review"
//
// Merge tags expected:
//   client.firstName       ({{first_name}})
//   project.projectName    ({{project_name}})
//   project.clientName     ({{project_subtitle}})
//   project.id / shortId   ({{project_id}})
//   videos                 array of { name, videoId }
//   videosCount            number — falls back to videos.length or 1
//   producerNote           optional free-text rendered as a note block
//   delivery.url           the Viewix delivery page URL — primary CTA
//   producer / editor      optional chips
//
// This template is the ONLY one with an in-hero CTA button (the
// "View on Viewix dashboard ->" link). When the CTA renders, the
// layout's footer dashboard link is suppressed via hasInHeroCta.

import { h } from "../_h.js";
import { Button, Heading, Text } from "@react-email/components";
import { BRAND, Layout, heroStyles } from "./_layout.js";

const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const styles = {
  noteBlock: {
    backgroundColor: BRAND.off,
    padding: "14px 16px",
    borderRadius: "8px",
    margin: "0 0 20px",
    borderLeft: `3px solid ${BRAND.blue}`,
  },
  noteLabel: {
    fontFamily: FONT_MONO,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "10px",
    color: BRAND.inkSofter,
    margin: "0 0 4px",
  },
  noteText: {
    fontSize: "14px",
    color: BRAND.ink,
    margin: 0,
    lineHeight: 1.6,
  },
};

export default function ReadyForReview(props) {
  const firstName = props?.client?.firstName || "there";
  const accent = props?.accent || "blue";
  const deliveryUrl = props?.delivery?.url || "";
  const producerNote = (props?.producerNote || "").trim();

  const videos = Array.isArray(props?.videos) ? props.videos : [];
  const count = videos.length || Number(props?.videosCount) || 1;
  const isBatch = count > 1;

  // Stage 4 copy. Headline matches the design's "Ready for your eyes".
  // Body slightly adapted for batch vs single — natural in both cases.
  const headline = isBatch
    ? `${count} videos ready for your eyes`
    : "Ready for your eyes";
  const bodyCopy = isBatch
    ? "The first cuts for this batch are ready to watch. Have a look when you get a moment, leave timestamped notes on the dashboard, or send a thumbs up. Most clients send all their feedback in one go - that's the move if you can."
    : "The first cut is ready to watch. Have a look when you get a moment, leave timestamped notes on the dashboard, or send a thumbs up. Most clients send all their feedback in one go - that's the move if you can.";
  // Unified CTA label per Jeremy's spec — same button on single, batch,
  // and any future case. Cleaner brand voice than "View on Viewix
  // dashboard →" with its directional arrow.
  const ctaLabel = "View Videos Here";

  return h(
    Layout,
    {
      stage: 4,
      preview: isBatch
        ? `${firstName}, ${count} videos ready for review.`
        : `${firstName}, your video is ready for review.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      // No dashboardUrl in the footer — the in-hero CTA carries the link.
      dashboardUrl: null,
      hasInHeroCta: !!deliveryUrl,
    },
    h(Text, { style: heroStyles.eyebrow(accent) }, "Ready for your eyes"),
    h(Heading, { as: "h1", style: heroStyles.headline }, headline),
    h(Text, { style: heroStyles.body }, `Hi ${firstName}, ${bodyCopy}`),

    // Producer note block — left-bordered, soft background. Only
    // renders when the producer added a note at send time.
    producerNote
      ? h(
          "div",
          { style: styles.noteBlock },
          h(Text, { style: styles.noteLabel }, "Note from the team"),
          h(Text, { style: styles.noteText }, producerNote)
        )
      : null,

    // Primary CTA -> delivery page. Resend renders Button as a
    // bulletproof table-based button (Outlook-safe).
    //
    // Hard requirement (Jeremy's spec 2026-05-12): the email MUST have
    // a real delivery URL. If delivery.url is missing the template
    // renders without the button — and the calling endpoint
    // (notify-finish.js / send-review-batch.js) is responsible for
    // refusing the send entirely. No fallback link is shown because
    // there's no client-viewable destination to send them to. Phase
    // A.5's batch-send endpoint guards on this server-side; if a send
    // ever reaches this template with no URL it's a bug, not a UX
    // case to design for.
    deliveryUrl
      ? h(
          Button,
          { href: deliveryUrl, style: heroStyles.cta(accent) },
          ctaLabel
        )
      : null
  );
}
