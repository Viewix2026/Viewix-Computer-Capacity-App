// api/_email/templates/ShootTomorrow.js
// Phase B — Refined direction, Stage 2 (Shooting).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx +
// viewix-touchpoints/project/src/data.jsx STAGES[1].
//
// Trigger: api/cron/daily-09.js Pass 1, when a shoot-stage subtask has
// startDate === tomorrow (Sydney). One per shoot subtask per startDate.
// Idempotency: /emailLog/{projectId}/ShootTomorrow/{subtaskId}/{startDate}.
//
// Subject (locked 2026-05-13): "Excited to shoot tomorrow, {firstName}!"
// (falls back to "Excited to shoot tomorrow!" when first name is missing).
// Personalisation in the subject is Jeremy's approved exception to the
// "no personalisation in subject" deliverability rule — the day-before-
// shoot email is the warmest touchpoint in the lifecycle. Built in
// api/cron/daily-09.js SUBJECTS.ShootTomorrow().
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

// AU mobile formatter — mirrors PersonChip's helper in _layout.js so
// crew phones in this email's "Who you'll meet" block render in the
// same "0477 515 963" form as the Account Manager chip.
function formatPhoneAU(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/[^\d]/g, "");
  if (/^04\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return String(raw).trim();
}

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
    margin: "0 0 10px",
    lineHeight: 1.45,
  },
  crewName: {
    fontWeight: 700,
    color: BRAND.ink,
  },
  crewMeta: {
    color: BRAND.inkSofter,
  },
  crewAvatar: {
    display: "block",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "0",
    objectFit: "cover",
  },
  crewAvatarFallback: {
    display: "inline-block",
    width: "36px",
    height: "36px",
    lineHeight: "36px",
    borderRadius: "50%",
    backgroundColor: BRAND.off,
    color: BRAND.inkMuted,
    fontWeight: 700,
    fontSize: "12px",
    textAlign: "center",
  },
  crewTextLine: {
    fontSize: "14px",
    color: BRAND.ink,
    margin: 0,
    lineHeight: 1.3,
  },
  crewMetaLine: {
    fontSize: "12.5px",
    color: BRAND.inkSofter,
    margin: "2px 0 0",
    lineHeight: 1.3,
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

  // Stage 2 copy. Updated 2026-05-12 per Jeremy: exclamation on the
  // headline + warmer second sentence ("We're excited to film with
  // you tomorrow.") replacing the production-flow detail. The
  // shoot-day email is about the relationship, not the workflow.
  const headline = "Excited to shoot tomorrow!";
  const bodyCopy = "Your crew is locked in and ready to roll. We're excited to film with you tomorrow.";

  return h(
    Layout,
    {
      stage: 2,
      preview: `${firstName}, see you tomorrow. Here's the crew and call sheet.`,
      accent,
      project: props?.project,
      producer: props?.producer,
      editor: props?.editor,
      // ShootTomorrow intentionally has no dashboard link in the
      // footer. Removed 2026-05-12 per Jeremy — clients don't need
      // a "view project on dashboard" link on a shoot-day email;
      // the message is purely about tomorrow's logistics.
      dashboardUrl: null,
      hasInHeroCta: false,
      // Per Jeremy's request 2026-05-11: ShootTomorrow's Up Next
      // reads "Your videos are in the edit suite." instead of the
      // generic Stage 2 default ("Footage ingest & first edit pass").
      // This matches the client-facing language of the next email
      // they'll receive (InEditSuite) so the lifecycle reads as a
      // continuous narrative.
      upNext: "Your videos are in the edit suite.",
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

    // Crew block — face + name + role + phone, one row per person.
    // Slack profile photo from /editors renders as a 36px circle on
    // the left, with name (bold) + role · phone stacked on the
    // right. Missing avatar -> initials disc fallback so the row
    // still looks intentional. Missing phone -> phone segment
    // hidden, the rest stays. Only rendered when at least one crew
    // member resolved.
    crew.length > 0
      ? h(
          Fragment,
          null,
          h(Text, { style: styles.detailLabel }, "Who you'll meet"),
          ...crew.map(c => {
            const initials = (c.name || "")
              .trim()
              .split(/\s+/)
              .map(w => w.charAt(0))
              .slice(0, 2)
              .join("")
              .toUpperCase();
            const avatarNode = c.avatar
              ? h("img", {
                  src: c.avatar,
                  alt: c.name,
                  width: 36,
                  height: 36,
                  style: styles.crewAvatar,
                })
              : h("div", { style: styles.crewAvatarFallback }, initials);
            return h(
              Row,
              { key: c.id || c.name, style: { marginBottom: "10px" } },
              h(
                Column,
                { style: { width: "44px", verticalAlign: "middle", lineHeight: 0 } },
                avatarNode
              ),
              h(
                Column,
                { style: { verticalAlign: "middle", paddingLeft: "10px" } },
                h(
                  Text,
                  { style: styles.crewTextLine },
                  h("span", { style: styles.crewName }, c.name),
                  c.role ? h("span", { style: styles.crewMeta }, ` · ${c.role}`) : null
                ),
                c.hasPhone
                  ? h(
                      Text,
                      { style: styles.crewMetaLine },
                      h(
                        "a",
                        {
                          href: `tel:${String(c.phone).replace(/[^\d+]/g, "")}`,
                          style: { color: BRAND.inkSofter, textDecoration: "none" },
                        },
                        formatPhoneAU(c.phone)
                      )
                    )
                  : null
              )
            );
          })
        )
      : null,

    // Notice: redirect non-shoot-day questions to the account
    // manager. Renders even when there are no crew phones — keeps
    // the client's escalation path clear regardless.
    h(
      Text,
      { style: { ...heroStyles.body, fontStyle: "italic", color: BRAND.inkSofter, fontSize: "12.5px" } },
      "For any other communication, please contact your account manager."
    )
  );
}
