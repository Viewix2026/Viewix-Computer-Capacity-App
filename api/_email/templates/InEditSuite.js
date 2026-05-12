// api/_email/templates/InEditSuite.js
// Phase B — Refined direction, Stage 3 (Editing).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[2].
//
// Trigger: api/cron/daily-09.js Pass 3, when a project newly has at
// least one edit-stage subtask in "inProgress" and no prior log
// entry. One per project. Idempotency: /emailLog/{projectId}/InEditSuite.
//
// Subject (Jeremy to approve before live): "It's in the edit suite"
//
// Merge tags expected:
//   client.firstName       ({{first_name}})
//   project.projectName    ({{project_name}})
//   project.clientName     ({{project_subtitle}})
//   project.id / shortId   ({{project_id}})
//   editor                 (optional — surfaced in the project card chip)
//   delivery.url           (optional; rendered as the footer dashboard link)

import { h } from "../_h.js";
import { Heading, Text } from "@react-email/components";
import { Layout, heroStyles } from "./_layout.js";

export default function InEditSuite(props) {
  const firstName = props?.client?.firstName || "there";
  const accent = props?.accent || "blue";

  // Stage 3 copy from data.jsx STAGES[2].
  const headline = "It's in the edit suite";
  // Body kept version-agnostic — same reasoning as ReadyForReview:
  // this email's "next up" is the review email, which may be the
  // initial cut OR a revision round.
  const bodyCopy = "Your edit is now underway. Our team is shaping the cut, colour and sound. You'll hear from us as soon as it's ready for your eyes.";

  return h(
    Layout,
    {
      stage: 3,
      preview: `${firstName}, your project is in the edit suite. First cut coming soon.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      // No dashboard link in the footer. Removed 2026-05-12 per
      // Jeremy — same reasoning as ShootTomorrow: the InEditSuite
      // email is a status note, not an action item. The client
      // doesn't need a generic dashboard link here; the
      // ReadyForReview email (next in the lifecycle) carries the
      // call-to-action.
      dashboardUrl: null,
      hasInHeroCta: false,
    },
    h(Text, { style: heroStyles.eyebrow(accent) }, "In the edit suite"),
    h(Heading, { as: "h1", style: heroStyles.headline }, headline),
    h(
      Text,
      { style: heroStyles.body },
      `Hi ${firstName}, ${bodyCopy}`
    )
  );
}
