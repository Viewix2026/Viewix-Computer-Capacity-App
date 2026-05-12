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
  // Body copy stays version-agnostic — this email also fires on
  // v2 / v3 / revision rounds, not just the very first cut. Earlier
  // "first cut" wording would have been wrong on every send after
  // the kickoff round.
  const bodyCopy = isBatch
    ? "Your videos are ready to watch. Have a look when you get a moment, leave timestamped notes when watching each video, or approve the video. Most clients send all their feedback in one go - that's the move if you can."
    : "Your video is ready to watch. Have a look when you get a moment, leave timestamped notes when watching each video, or approve the video. Most clients send all their feedback in one go - that's the move if you can.";
  // Unified CTA label per Jeremy's spec — same button on single, batch,
  // and any future case. Cleaner brand voice than "View on Viewix
  // dashboard →" with its directional arrow.
  const ctaLabel = "View Videos Here";

  // Per Jeremy's spec 2026-05-12: ReadyForReview shows ONE chip in
  // the project card — the account manager. Other emails (Confirmation,
  // ShootTomorrow, InEditSuite) keep the producer + editor pair. The
  // account manager is the right escalation contact at the review
  // stage; producer/editor names are noise once the client just needs
  // to know who to reply to about feedback.
  //
  // Mapping: our context loader resolves `producer` from the project's
  // account.accountManager already. We just relabel the role for this
  // template's chip, and explicitly null out the editor. Pass through
  // the avatar URL so the chip renders the Slack profile photo, not
  // just initials.
  const accountManagerChip = props?.producer && props.producer.name
    ? {
        name: props.producer.name,
        role: "Account Manager",
        initials: props.producer.initials,
        avatar: props.producer.avatar || props.producer.avatarUrl,
        // Phone passes through so the AM's mobile renders under the
        // role in the chip — same behaviour as every other email.
        // Earlier omission was a bug in the chip relabel (2026-05-12).
        phone: props.producer.phone || null,
      }
    : null;

  return h(
    Layout,
    {
      stage: 4,
      preview: isBatch
        ? `${firstName}, ${count} videos ready for review.`
        : `${firstName}, your video is ready for review.`,
      accent,
      project: props?.project,
      producer: accountManagerChip,
      editor: null,
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
