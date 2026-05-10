// api/_email/templates/ReadyForReview.js
// Phase A placeholder. Real Claude Design version lands in Phase B.
//
// Trigger: api/notify-finish.js, when reviewType === "client". Per
// video; idempotency key
//   /emailLog/{projectId}/ReadyForReview/{videoId || subtaskId}
//
// Subject (Phase A draft):
//   "Your video is ready to watch"
//
// Merge tags expected:
//   client.firstName
//   project.projectName
//   delivery.url           (Viewix delivery page — required, no fallback to Frame.io)
//   videoName              (optional — surfaced as a sub-line)

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
  videoName: {
    fontSize: "14px",
    color: BRAND.inkSofter,
    fontFamily: "'JetBrains Mono', monospace",
    margin: "0 0 18px",
  },
};

export default function ReadyForReview(props) {
  const firstName = props?.client?.firstName || "there";
  const projectName = props?.project?.projectName || "your project";
  const deliveryUrl = props?.delivery?.url || "";
  const videoName = props?.videoName || "";

  return h(
    Layout,
    {
      preview: `${firstName}, your video for ${projectName} is ready to watch.`,
      title: "Ready to review",
    },
    h(Heading, { style: styles.h1 }, `Your video is ready, ${firstName}.`),
    h(
      Text,
      { style: styles.intro },
      "The first cut for ",
      h("strong", null, projectName),
      " is up on your delivery page and waiting for your eyes."
    ),
    videoName
      ? h(Text, { style: styles.videoName }, videoName)
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
          "Watch on your delivery page"
        )
      : h(Text, { style: { color: BRAND.orangeDark, fontWeight: 600 } }, "(Delivery link unavailable — please reply and we'll send it directly.)")
  );
}
