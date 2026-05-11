// api/_email/templates/Confirmation.js
// Phase B — Refined direction, Stage 1 (Kickoff).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[0].
//
// Trigger: api/webhook-deal-won.js right after the project record is
// created. One per project. Idempotency: /emailLog/{projectId}/Confirmation.
//
// Subject (Jeremy to approve before live): "You're locked in"
//
// Merge tags expected:
//   client.firstName        ({{first_name}})
//   project.projectName     ({{project_name}})
//   project.clientName      ({{project_subtitle}})
//   project.id / shortId    ({{project_id}})
//   project.numberOfVideos  (optional; surfaced in body copy fallback)
//   producer                (optional { name, role, initials })
//   editor                  (optional { name, role, initials })
//   delivery.url            (optional; rendered as the footer dashboard link)

import { h } from "../_h.js";
import { Heading, Text } from "@react-email/components";
import { Layout, heroStyles } from "./_layout.js";

export default function Confirmation(props) {
  const firstName = props?.client?.firstName || "there";
  const accent = props?.accent || "blue";

  // Stage 1 copy. From data.jsx STAGES[0].body, with hyphens.
  const headline = "You're locked in";
  const bodyCopy = "We've got your brief and everything's loaded into the studio. Your producer will reach out in the next 48 hours to confirm shoot dates and logistics.";

  return h(
    Layout,
    {
      stage: 1,
      preview: `${firstName}, you're locked in. Here's what happens next.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      dashboardUrl: props?.delivery?.url || null,
      hasInHeroCta: false,
    },
    h(Text, { style: heroStyles.eyebrow(accent) }, "Brief locked in"),
    h(Heading, { as: "h1", style: heroStyles.headline }, headline),
    h(
      Text,
      { style: heroStyles.body },
      `Hi ${firstName}, ${bodyCopy}`
    )
  );
}
