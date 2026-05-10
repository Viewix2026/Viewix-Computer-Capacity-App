// api/_email/templates/InEditSuite.js
// Phase A placeholder. Real Claude Design version lands in Phase B.
//
// Trigger: api/cron/daily-09.js Pass 3, when a project newly has at
// least one edit-stage subtask in `inProgress` and no prior log
// entry. One per project; idempotency key /emailLog/{projectId}/InEditSuite.
//
// Subject (Phase A draft):
//   "Your videos are in the edit suite"
//
// Merge tags expected:
//   client.firstName
//   project.projectName
//   project.numberOfVideos       (optional — falls back to "your videos")

import { h } from "../_h.js";
import { Heading, Text } from "@react-email/components";
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
};

export default function InEditSuite(props) {
  const firstName = props?.client?.firstName || "there";
  const projectName = props?.project?.projectName || "your project";
  const videoCountText = props?.project?.numberOfVideos
    ? (props.project.numberOfVideos === 1 ? "your video" : `your ${props.project.numberOfVideos} videos`)
    : "your videos";

  return h(
    Layout,
    {
      preview: `${firstName}, ${videoCountText} just landed on an editor's timeline.`,
      title: "In the edit suite",
    },
    h(Heading, { style: styles.h1 }, `${videoCountText.charAt(0).toUpperCase() + videoCountText.slice(1)} are in the edit suite.`),
    h(
      Text,
      { style: styles.intro },
      `Hey ${firstName} — quick update from the team behind `,
      h("strong", null, projectName),
      ". The footage from your shoot is now on an editor's timeline and the cuts are coming together."
    ),
    h(
      Text,
      { style: styles.body },
      "Editing is the part where we shape the rough footage into something that actually moves people. Music, pacing, the way one shot leans into the next — it all gets sweated over here."
    ),
    h(
      Text,
      { style: styles.body },
      "Next time you hear from us, it'll be with a link to watch the first cut. In the meantime, no action needed from you — but if a thought pops up about what you want this video to do, hit reply and tell us. The earlier we know, the better the cut."
    )
  );
}
