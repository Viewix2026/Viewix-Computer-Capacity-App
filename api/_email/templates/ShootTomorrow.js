// api/_email/templates/ShootTomorrow.js
// Phase A placeholder. Real Claude Design version lands in Phase B.
//
// Trigger: api/cron/daily-09.js Pass 1, when a shoot-stage subtask
// has startDate === tomorrow (Sydney). One per shoot subtask per
// startDate; idempotency key
//   /emailLog/{projectId}/ShootTomorrow/{subtaskId}/{startDate}
//
// Subject (Phase A draft):
//   "See you tomorrow, [Client first name]"
//
// Merge tags expected (sourced from getProjectContext + buildShootContext):
//   client.firstName
//   project.projectName
//   shoot.dateLabel        e.g. "Friday 17 May 2026"
//   shoot.endDateLabel     (multi-day)
//   shoot.timeLabel        e.g. "9:30am – 5:00pm"
//   shoot.location         (optional — line is hidden if empty)
//   shoot.multiDay         boolean
//   shoot.crew             [{ name, phone, role, hasPhone }]

import { h, Fragment } from "../_h.js";
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
  detailLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "11px",
    color: BRAND.inkSofter,
    margin: "16px 0 4px",
  },
  detailValue: {
    fontSize: "15px",
    color: BRAND.ink,
    margin: "0",
    lineHeight: 1.5,
  },
  crewRow: {
    fontSize: "15px",
    color: BRAND.ink,
    margin: "0 0 6px",
    lineHeight: 1.45,
  },
  notice: {
    fontSize: "13px",
    color: BRAND.inkSofter,
    fontStyle: "italic",
    margin: "18px 0 0",
    lineHeight: 1.55,
    backgroundColor: BRAND.off,
    padding: "12px 14px",
    borderRadius: "8px",
  },
};

export default function ShootTomorrow(props) {
  const firstName = props?.client?.firstName || "there";
  const projectName = props?.project?.projectName || "your project";
  const shoot = props?.shoot || {};
  const crew = Array.isArray(shoot.crew) ? shoot.crew : [];

  const dateLine = shoot.multiDay && shoot.endDateLabel
    ? `${shoot.dateLabel} — ${shoot.endDateLabel}`
    : (shoot.dateLabel || "(date to confirm)");

  return h(
    Layout,
    {
      preview: `See you tomorrow, ${firstName}. Here's everything for the shoot.`,
      title: "Shoot tomorrow",
    },
    h(Heading, { style: styles.h1 }, `See you tomorrow, ${firstName}.`),
    h(
      Text,
      { style: styles.intro },
      `Quick heads-up before our shoot for `,
      h("strong", null, projectName),
      ". Everything's locked in and the crew can't wait to get going."
    ),

    h(Text, { style: styles.detailLabel }, shoot.multiDay ? "Dates" : "Date"),
    h(Text, { style: styles.detailValue }, dateLine),

    shoot.timeLabel
      ? h(Fragment, null,
          h(Text, { style: styles.detailLabel }, "Time"),
          h(Text, { style: styles.detailValue }, shoot.timeLabel)
        )
      : null,

    shoot.location
      ? h(Fragment, null,
          h(Text, { style: styles.detailLabel }, "Location"),
          h(Text, { style: styles.detailValue }, shoot.location)
        )
      : null,

    crew.length > 0
      ? h(Fragment, null,
          h(Text, { style: styles.detailLabel }, "Who you'll meet"),
          ...crew.map(c =>
            h(Text, { style: styles.crewRow, key: c.id || c.name },
              h("strong", null, c.name),
              c.role ? ` · ${c.role}` : "",
              c.hasPhone ? ` · ${c.phone}` : ""
            )
          )
        )
      : null,

    h(
      Text,
      { style: styles.notice },
      "These mobiles are for tomorrow only — anything before or after, just hit reply on this email and you'll get a real human at Viewix."
    )
  );
}
