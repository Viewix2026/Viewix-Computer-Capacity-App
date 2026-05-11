// api/_email/templates/ReadyForReview.js
// Phase A placeholder. Real Claude Design version lands in Phase B.
//
// Trigger (post-redesign, 2026-05-10): producer/AM-driven batch
// flow via api/send-review-batch.js (planned Phase A.5). Editors
// flag videos as "Ready for Review" through their Finish modal as
// before; the producer/AM then opens the project's Deliveries
// view, picks one or more flagged videos (defaulting to all
// editor-flagged, with an override to "show all"), optionally
// adds a producer note, and clicks Send. One email per batch.
//
// Idempotency key (Phase A.5): /emailLog/{projectId}/ReadyForReview/{batchId}
// where batchId is generated server-side at send time.
//
// Subject (Phase A draft, batch-aware):
//   "Your videos are ready to watch"
//
// Merge tags expected:
//   client.firstName
//   project.projectName
//   videos                 array of { name, videoId } for the videos in this batch
//   videosCount            number — len(videos), surfaced separately for templates that don't iterate
//   producerNote           optional free-text from the producer at send time (renders only if non-empty)
//   delivery.url           Viewix delivery page (required — built via buildDeliveryUrl())

import { h } from "../_h.js";
import { Button, Heading, Text } from "@react-email/components";
import { Layout, BRAND } from "./_layout.js";

const styles = {
  h1: {
    fontFamily: "'Montserrat', sans-serif",
    fontSize: "24px",
    fontWeight: 700,
    color: BRAND.ink,
    margin: "0 0 12px",
    lineHeight: 1.25,
  },
  intro: {
    fontSize: "16px",
    color: BRAND.ink,
    lineHeight: 1.6,
    margin: "0 0 18px",
  },
  body: {
    fontSize: "15px",
    color: BRAND.inkSoft,
    lineHeight: 1.65,
    margin: "0 0 16px",
  },
  cta: {
    backgroundColor: BRAND.blue,
    color: BRAND.panel,
    fontFamily: "'Montserrat', sans-serif",
    fontWeight: 700,
    padding: "14px 26px",
    borderRadius: "8px",
    textDecoration: "none",
    display: "inline-block",
    fontSize: "16px",
    marginTop: "8px",
  },
  noteBlock: {
    fontSize: "14px",
    color: BRAND.ink,
    lineHeight: 1.6,
    backgroundColor: BRAND.off,
    padding: "14px 16px",
    borderRadius: "8px",
    margin: "0 0 18px",
    borderLeft: `3px solid ${BRAND.blue}`,
  },
  noteLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "10px",
    color: BRAND.inkSofter,
    margin: "0 0 4px",
  },
};

export default function ReadyForReview(props) {
  const firstName = props?.client?.firstName || "there";
  const projectName = props?.project?.projectName || "your project";
  const deliveryUrl = props?.delivery?.url || "";
  const producerNote = (props?.producerNote || "").trim();

  // Count is sourced from videos[] when provided; otherwise from
  // the explicit videosCount prop; otherwise defaults to 1 so the
  // copy still reads sensibly for legacy single-video callers.
  const videos = Array.isArray(props?.videos) ? props.videos : [];
  const count = videos.length || Number(props?.videosCount) || 1;

  // Singular/plural copy. The Phase B design will likely override
  // this entirely, but the placeholder needs to read naturally.
  const videoNoun = count === 1 ? "video is" : "videos are";
  const headerCopy = count === 1
    ? `Your video is ready, ${firstName}.`
    : `Your ${count} videos are ready, ${firstName}.`;
  const previewCopy = count === 1
    ? `${firstName}, your video for ${projectName} is ready to watch.`
    : `${firstName}, ${count} videos for ${projectName} are ready to watch.`;
  const introBody = count === 1
    ? "is up on your delivery page and waiting for your eyes."
    : "are up on your delivery page and waiting for your eyes.";

  return h(
    Layout,
    {
      preview: previewCopy,
      title: "Ready to review",
    },
    h(Heading, { style: styles.h1 }, headerCopy),
    h(
      Text,
      { style: styles.intro },
      `The latest ${count === 1 ? "cut" : "cuts"} for `,
      h("strong", null, projectName),
      ` ${introBody}`
    ),

    producerNote
      ? h(
          "div",
          { style: styles.noteBlock },
          h(Text, { style: styles.noteLabel }, "Note from the team"),
          h(Text, { style: { margin: 0, fontSize: 14, lineHeight: 1.55 } }, producerNote)
        )
      : null,

    h(
      Text,
      { style: styles.body },
      "Watch through, leave timestamped notes anywhere you want a tweak, and we'll turn revisions around fast. Most clients send all their feedback in one go — that's the move if you can."
    ),
    deliveryUrl
      ? h(
          Button,
          { href: deliveryUrl, style: styles.cta },
          count === 1 ? "Watch on your delivery page" : "Watch all on your delivery page"
        )
      : h(Text, { style: { color: BRAND.orangeDark, fontWeight: 600 } }, "(Delivery link unavailable — please reply and we'll send it directly.)")
  );
}
