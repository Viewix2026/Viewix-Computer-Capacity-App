// api/_email/templates/Confirmation.js
// Phase B — Refined direction, Stage 1 (Kickoff).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[0].
//
// Trigger: api/webhook-deal-won.js right after the project record is
// created. One per project. Idempotency: /emailLog/{projectId}/Confirmation.
//
// Subject (Jeremy to approve before live): "You're booked in"
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

  // Stage 1 copy. Updated 2026-05-12 per Jeremy: headline reads
  // "You're booked in" (was "You're locked in") — softer welcome
  // tone, more accurate to the reality of having a booking on the
  // schedule.
  const headline = "You're booked in";
  const bodyCopy = "We've got your brief and everything's loaded into the studio. We're excited to bring your brand to life.";

  return h(
    Layout,
    {
      stage: 1,
      preview: `${firstName}, you're booked in. We're excited to bring your brand to life.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      // No dashboard link in the footer. Removed 2026-05-12 per
      // Jeremy — the Confirmation email is a welcome note, not an
      // action item. ReadyForReview is the email that carries the
      // CTA into the dashboard; everything before it stays
      // navigationally clean.
      dashboardUrl: null,
      hasInHeroCta: false,
      // Per Jeremy's review 2026-05-11: Confirmation's Up Next reads
      // "Your shoot day" instead of the generic Stage 1 default
      // ("Producer call & shoot scheduling"). Matches the client-
      // facing language and keeps the lifecycle narrative simple.
      upNext: "Your shoot day",
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
