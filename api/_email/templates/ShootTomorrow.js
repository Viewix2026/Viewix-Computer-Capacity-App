// api/_email/templates/ShootTomorrow.js
// Phase B — Refined direction, Stage 2 (Shooting).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[1].
//
// Trigger: api/cron/daily-09.js Pass 1, when a shoot-stage subtask has
// startDate === tomorrow (Sydney). One per shoot subtask per startDate.
// Idempotency: /emailLog/{projectId}/ShootTomorrow/{subtaskId}/{startDate}.
//
// Subject (Jeremy to approve before live): "Excited to shoot tomorrow"
//
// Merge tags expected:
//   client.firstName           ({{first_name}})
//   project.projectName        ({{project_name}})
//   project.clientName         ({{project_subtitle}})
//   project.id / shortId       ({{project_id}})
//   shoot.dateLabel            ({{shoot_date}}, e.g. "Friday 17 May 2026")
//   shoot.endDateLabel         (multi-day shoots)
//   shoot.timeLabel            ("8:30am - 5:00pm")
//   shoot.location             (free-text, optional)
//   shoot.multiDay             boolean
//   shoot.crew                 [{ name, phone, role, hasPhone }]
//   producer / editor          optional chips
//
// The crew block is unique to this template — names + roles + phones,
// rendered between the hero body and the project card. The "use these
// mobiles for tomorrow only" notice stays at the end of the body copy.

import { h, Fragment } from "../_h.js";
import { Column, Heading, Row, Section, Text } from "@react-email/components";
import { BRAND, Layout, heroStyles } from "./_layout.js";

const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const styles = {
  detailLabel: {
    fontFamily: FONT_MONO,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "10px",
    color: BRAND.inkMuted,
    margin: "0 0 4px",
  },
  detailValue: {
    fontSize: "14px",
    color: BRAND.ink,
    margin: "0 0 12px",
    lineHeight: 1.45,
  },
  detailBlock: {
    padding: "0 28px 4px",
  },
  crewWrap: {
    padding: "4px 28px 14px",
  },
  crewRow: {
    fontSize: "14px",
    color: BRAND.ink,
    margin: "0 0 6px",
    lineHeight: 1.45,
  },
  crewName: {
    fontWeight: 700,
    color: BRAND.ink,
  },
  crewMeta: {
    color: BRAND.inkSofter,
  },
  notice: {
    fontSize: "12px",
    color: BRAND.inkSofter,
    fontStyle: "italic",
    margin: "12px 28px 4px",
    lineHeight: 1.55,
    backgroundColor: BRAND.off,
    padding: "12px 14px",
    borderRadius: "8px",
  },
};

export default function ShootTomorrow(props) {
  const firstName = props?.client?.firstName || "there";
  const accent = props?.accent || "blue";
  const shoot = props?.shoot || {};
  const crew = Array.isArray(shoot.crew) ? shoot.crew : [];

  const dateLine = shoot.multiDay && shoot.endDateLabel
    ? `${shoot.dateLabel || ""} - ${shoot.endDateLabel}`
    : (shoot.dateLabel || "");

  // Stage 2 copy. From data.jsx STAGES[1] with the corrected headline
  // ("Excited to shoot tomorrow" per Jeremy's design chat).
  const headline = "Excited to shoot tomorrow";
  const bodyCopy = "Your crew is locked in and ready to roll. Once we wrap the shoot, everything moves straight into the edit suite.";

  return h(
    Layout,
    {
      stage: 2,
      preview: `${firstName}, see you tomorrow. Here's the crew and call sheet.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      dashboardUrl: props?.delivery?.url || null,
      hasInHeroCta: false,
    },
    // Hero block (children of Layout's hero <Section>)
    h(Text, { style: heroStyles.eyebrow(accent) }, "On location"),
    h(Heading, { as: "h1", style: heroStyles.headline }, headline),
    h(Text, { style: heroStyles.body }, `Hi ${firstName}, ${bodyCopy}`),

    // Shoot details: date + time + location. Each line only renders if
    // the corresponding field is present. Avoids "(time to confirm)"
    // placeholders that look sloppy.
    dateLine || shoot.timeLabel || shoot.location
      ? h(
          Fragment,
          null,
          dateLine
            ? h(
                Fragment,
                null,
                h(Text, { style: styles.detailLabel }, shoot.multiDay ? "Dates" : "Date"),
                h(Text, { style: styles.detailValue }, dateLine)
              )
            : null,
          shoot.timeLabel
            ? h(
                Fragment,
                null,
                h(Text, { style: styles.detailLabel }, "Time"),
                h(Text, { style: styles.detailValue }, shoot.timeLabel)
              )
            : null,
          shoot.location
            ? h(
                Fragment,
                null,
                h(Text, { style: styles.detailLabel }, "Location"),
                h(Text, { style: styles.detailValue }, shoot.location)
              )
            : null
        )
      : null,

    // Crew block — names + roles + phones. Rendered only when crew
    // resolves to at least one person. Missing phones gracefully
    // hidden per-row (the name + role still show).
    crew.length > 0
      ? h(
          Fragment,
          null,
          h(Text, { style: styles.detailLabel }, "Who you'll meet"),
          ...crew.map(c =>
            h(
              Text,
              { style: styles.crewRow, key: c.id || c.name },
              h("span", { style: styles.crewName }, c.name),
              c.role ? h("span", { style: styles.crewMeta }, ` · ${c.role}`) : null,
              c.hasPhone ? h("span", { style: styles.crewMeta }, ` · ${c.phone}`) : null
            )
          )
        )
      : null,

    // Notice: mobiles are tomorrow-only. Last in the hero block.
    crew.some(c => c.hasPhone)
      ? h(
          Text,
          { style: { ...heroStyles.body, fontStyle: "italic", color: BRAND.inkSofter, fontSize: "12.5px" } },
          "These mobiles are for tomorrow only. Anything before or after, just hit reply and you'll get a real human at Viewix."
        )
      : null
  );
}
