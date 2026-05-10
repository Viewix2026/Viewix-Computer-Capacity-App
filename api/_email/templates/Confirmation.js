// api/_email/templates/Confirmation.js
// Phase A placeholder. Real Claude Design version lands in Phase B.
//
// Trigger: api/webhook-deal-won.js, immediately after the project record
// is created. One per project, idempotency key /emailLog/{projectId}/Confirmation.
//
// Subject (Phase A draft, Jeremy to approve before live):
//   "You're locked in — here's what happens next"
//
// Merge tags expected (sourced from getProjectContext):
//   client.firstName
//   project.projectName
//   project.clientName
//   project.numberOfVideos        (optional — falls back to "your videos")

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
    margin: "0 0 14px",
  },
  cta: {
    backgroundColor: BRAND.orange,
    color: BRAND.panel,
    fontFamily: "'Montserrat', sans-serif",
    fontWeight: 700,
    padding: "12px 22px",
    borderRadius: "8px",
    textDecoration: "none",
    display: "inline-block",
    marginTop: "8px",
  },
};

export default function Confirmation(props) {
  const firstName = props?.client?.firstName || "there";
  const projectName = props?.project?.projectName || "your project";
  const videoCountText = props?.project?.numberOfVideos
    ? `${props.project.numberOfVideos} ${props.project.numberOfVideos === 1 ? "video" : "videos"}`
    : "your videos";

  return h(
    Layout,
    {
      preview: `${firstName}, you're locked in. Here's what happens next on ${projectName}.`,
      title: "Confirmation",
    },
    h(Heading, { style: styles.h1 }, `You're locked in, ${firstName}.`),
    h(
      Text,
      { style: styles.intro },
      `Welcome to Viewix. We're producing ${videoCountText} for `,
      h("strong", null, projectName),
      ", and the whole team is excited to bring this to life."
    ),
    h(
      Text,
      { style: styles.body },
      "From here, you'll hear from us at every key moment — the day before the shoot, when editing kicks off, and the second your videos are ready to review. No silence between updates, ever."
    ),
    h(
      Text,
      { style: styles.body },
      "If anything comes up that you want to flag early — references, brand assets, an audience nuance — just hit reply. The fastest way to get to a great video is for us to know what's in your head."
    ),
    h(
      Button,
      { href: "https://viewix.com.au", style: styles.cta },
      "Visit viewix.com.au"
    )
  );
}
