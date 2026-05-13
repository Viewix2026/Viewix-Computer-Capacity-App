// api/_email/templates/_layout.js
// Phase B layout — Refined direction from Claude Design (Direction 01).
// Sourced from viewix-touchpoints/project/src/EmailRefined.jsx.
//
// Structure (top to bottom):
//   1. Header bar:    Viewix wordmark (left) + "CLIENT UPDATE" eyebrow (right)
//   2. Stepper:       "STAGE X OF 4" + project ID, then 4 dots + labels
//                     Done = ✓ in accent fill; current = filled accent; upcoming = empty
//   3. Hero block:    per-template children — eyebrow, headline, body, optional CTA
//   4. Project card:  project name + subtitle + producer chip + editor chip
//   5. Up next:       eyebrow divider + next-step text
//   6. Footer link:   "View project on dashboard ->" (rendered when no CTA in hero)
//   7. Footer:        "The Viewix team" + viewix.com.au
//
// Translates the original flex / absolute positioned design to React Email
// table primitives that Outlook desktop renders correctly. Where the
// design uses gradients / SVG / pulse animations (the per-stage imagery
// blocks), those are dropped from Phase B — they don't translate to email
// and the hero block carries the message on its own. Imagery can come
// back in a Phase C as static PNGs hosted under /public if needed.
//
// All copy uses hyphens, not em dashes (per Jeremy's correction on the
// design chat — "We're going to take out any end dashes and replace
// them with hyphens").

import { h } from "../_h.js";
import {
  Body,
  Button,
  Column,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";

// Brand variables. Centralised so every template (and the Phase B
// redesign) references one source of truth. Sourced from the
// Viewix brand guidelines + the design's data layer.
export const BRAND = {
  blue: "#0082FA",
  blueDark: "#004F99",
  orange: "#F87700",
  orangeDark: "#AE3A00",
  off: "#F4F5F9",
  offDeep: "#EEF0F4",
  panelTint: "#FAFBFC",
  borderLight: "#F0F1F5",
  borderMid: "#EEF0F4",
  borderStrong: "#E5E7EC",
  gray: "#CBCCD1",
  ink: "#0B0D12",
  inkMid: "#3A3F4C",
  inkSoft: "#4A4F5C",
  inkSofter: "#6B7180",
  inkMuted: "#9AA0AE",
  panel: "#FFFFFF",
  bg: "#EEF0F4",
};

// Email-safe font stack. Inter + Montserrat loaded via Google
// Fonts CDN in the Layout's <Head>. Outlook desktop strips
// webfonts so the system fallbacks must form a sensible stack on
// their own. JetBrains Mono is used for eyebrow / label text and
// uses ui-monospace + Menlo as fallbacks for the same reason.
const FONT_BODY    = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_DISPLAY = "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO    = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Per Codex review 2026-05-12: dedicated email-specific logo asset.
//
// Root cause of the earlier clipping bug: the original
// /public/viewix-logo.png was CORRUPTED — the IDAT chunk claimed
// 16319 bytes of pixel data in a file that's only 12576 bytes
// total. Browsers were rendering the partial-decoded image at
// natural size and ignoring our explicit dimensions because they
// were fighting through broken PNG data.
//
// Fix: regenerated both viewix-logo.png (600x160 for dashboard use)
// and viewix-logo-email.png (278x74 for email display at 139x37
// retina-sharp) from the clean 2400x638 source in the Claude
// Design handoff bundle. Pillow confirms both load cleanly.
//
// Email-side: use the smaller dedicated asset over HTTPS.
function brandLogoUrl() {
  const base = (process.env.PUBLIC_BASE_URL || "https://planner.viewix.com.au").replace(/\/+$/, "");
  return `${base}/viewix-logo-email.png`;
}

// Optional per-stage hero imagery URL helper. These files do not ship
// with Phase B yet, so Layout defaults imagery off. If we later add
// real assets, pass showImagery={true} and commit the matching files
// under /public/.
function heroImageUrl(stage) {
  const slugByStage = { 1: "kickoff", 2: "shoot", 3: "edit", 4: "review" };
  const slug = slugByStage[stage];
  if (!slug) return null;
  const base = (process.env.PUBLIC_BASE_URL || "https://planner.viewix.com.au").replace(/\/+$/, "");
  return `${base}/email-hero-${stage}-${slug}.png`;
}

// The 4 lifecycle stages, in order. Stage 1 = Kickoff (Confirmation),
// Stage 2 = Shooting (ShootTomorrow), Stage 3 = Editing (InEditSuite),
// Stage 4 = Review (ReadyForReview). Labels and the "next up" lines
// match the design's STAGES array verbatim, with hyphens not em dashes.
const STAGES = [
  { num: 1, label: "Kickoff",  next: "Producer call & shoot scheduling" },
  { num: 2, label: "Shooting", next: "Footage ingest & editing" },
  { num: 3, label: "Editing",  next: "Ready for your review" },
  { num: 4, label: "Review",   next: "Leave your feedback and finalize" },
];

const styles = {
  body: {
    backgroundColor: BRAND.bg,
    margin: 0,
    padding: 0,
    fontFamily: FONT_BODY,
    color: BRAND.ink,
  },
  outerWrap: {
    backgroundColor: BRAND.bg,
    padding: "32px 16px",
  },
  card: {
    backgroundColor: BRAND.panel,
    maxWidth: "560px",
    margin: "0 auto",
    borderRadius: "16px",
    overflow: "hidden",
    boxShadow:
      "0 1px 0 rgba(0,0,0,0.04), 0 30px 60px -30px rgba(12,16,24,0.35), 0 18px 36px -24px rgba(12,16,24,0.22)",
  },
  // ─── Header ────────────────────────────────────────────────
  // Bumped top/bottom padding from 22 to 28 so the 37px logo
  // sits centrally with breathing room above and below.
  header: {
    padding: "28px 28px",
    borderBottom: `1px solid ${BRAND.borderLight}`,
  },
  logoImg: {
    // Style mirrors the explicit width/height attributes so any
    // email client honouring style over attributes still gets the
    // right sizing. `display: block` strips the baseline gap an
    // inline <img> would inherit; `maxWidth: 100%` keeps it within
    // the column on very narrow viewports.
    width: "120px",
    height: "32px",
    display: "block",
    maxWidth: "100%",
    border: "0",
    outline: "none",
    textDecoration: "none",
  },
  headerEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: BRAND.inkMuted,
    margin: 0,
    textAlign: "right",
  },
  // ─── Stepper ───────────────────────────────────────────────
  stepperWrap: {
    padding: "28px 28px 0",
  },
  stepperMetaRow: {
    fontFamily: FONT_MONO,
    fontSize: "10px",
    letterSpacing: "0.14em",
    color: BRAND.inkMuted,
    textTransform: "uppercase",
    marginBottom: "12px",
  },
  stepperLabel: {
    fontFamily: FONT_BODY,
    fontSize: "10px",
    fontWeight: 500,
    color: BRAND.inkMuted,
    textAlign: "center",
    letterSpacing: "0.02em",
    margin: 0,
    padding: "8px 2px 0",
  },
  // ─── Hero ──────────────────────────────────────────────────
  hero: {
    padding: "28px 28px 8px",
  },
  heroEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    fontWeight: 600,
    marginBottom: "14px",
    margin: "0 0 14px",
  },
  heroHeadline: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 800,
    fontSize: "30px",
    lineHeight: 1.1,
    letterSpacing: "-0.025em",
    margin: "0 0 18px",
    color: BRAND.ink,
  },
  heroBody: {
    fontSize: "15px",
    lineHeight: 1.55,
    color: BRAND.inkMid,
    margin: "0 0 20px",
  },
  ctaButton: {
    background: BRAND.blue,
    color: BRAND.panel,
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: "13.5px",
    letterSpacing: "-0.005em",
    padding: "12px 18px",
    borderRadius: "8px",
    textDecoration: "none",
    display: "inline-block",
  },
  // ─── Project card ──────────────────────────────────────────
  projectCardWrap: {
    padding: "0 28px 24px",
  },
  projectCard: {
    backgroundColor: BRAND.panelTint,
    border: `1px solid ${BRAND.borderMid}`,
    borderRadius: "12px",
    padding: "16px 18px",
  },
  projectCardEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: "10px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: BRAND.inkMuted,
    margin: "0 0 10px",
  },
  projectCardName: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: "14px",
    letterSpacing: "-0.01em",
    margin: "0 0 4px",
    color: BRAND.ink,
  },
  projectCardSub: {
    fontSize: "12px",
    color: BRAND.inkSofter,
    lineHeight: 1.4,
    margin: "0 0 14px",
  },
  chipsRow: {
    borderTop: `1px solid ${BRAND.borderMid}`,
    paddingTop: "12px",
  },
  // ─── Up next ───────────────────────────────────────────────
  upNextEyebrow: {
    fontFamily: FONT_MONO,
    fontSize: "10px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: BRAND.inkMuted,
    margin: 0,
  },
  upNextText: {
    fontSize: "14px",
    color: BRAND.ink,
    fontWeight: 500,
    margin: 0,
    padding: "0 28px 30px",
  },
  upNextRow: {
    padding: "0 28px 12px",
  },
  upNextHr: {
    borderTop: `1px solid ${BRAND.borderMid}`,
    margin: 0,
    width: "100%",
  },
  // ─── Footer link (no-CTA case) ─────────────────────────────
  footerLinkWrap: {
    padding: "0 28px 30px",
  },
  footerLink: {
    fontFamily: FONT_MONO,
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    textDecoration: "none",
  },
  // ─── Footer ────────────────────────────────────────────────
  footer: {
    padding: "22px 28px",
    backgroundColor: BRAND.panelTint,
    borderTop: `1px solid ${BRAND.borderLight}`,
    textAlign: "center",
  },
  footerByline: {
    fontSize: "12px",
    color: BRAND.inkSofter,
    margin: "0 0 4px",
  },
  footerDomain: {
    fontFamily: FONT_MONO,
    fontSize: "10px",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: BRAND.inkMuted,
    margin: 0,
  },
};

// ────────────────────────────────────────────────────────────────
// Email header — wordmark left, "CLIENT UPDATE" eyebrow right.
//
// Logo sizing notes:
// - Source PNG is 301x80 (aspect ratio ~3.76:1)
// - Rendered at 140x37 to give a comfortable header presence
//
// IMPORTANT — this is a deliberate from-scratch rewrite using raw
// <table>/<tr>/<td> primitives instead of React Email's
// Section/Row/Column. Earlier attempts with the React Email
// abstractions caused the logo to clip at the top in the user's
// browser preview (the table cells were collapsing to a height
// shorter than the image, and the email card's `overflow:hidden`
// + border-radius then cut the top of the image off). The raw
// table approach explicitly sets cell heights and uses the
// `valign` attribute (more reliable than CSS vertical-align in
// table contexts) so the cell always grows to fit the image.
// ────────────────────────────────────────────────────────────────
function EmailHeader() {
  // Actual PNG logo served from the deployed dashboard domain. Avoid
  // data: URIs here; common email clients strip them.
  const tableStyle = {
    width: "100%",
    borderCollapse: "collapse",
    borderBottom: `1px solid ${BRAND.borderLight}`,
  };
  const cellLeftStyle = {
    padding: "24px 0 24px 28px",
    verticalAlign: "middle",
    width: "60%",
    lineHeight: "0",
  };
  const cellRightStyle = {
    padding: "24px 28px 24px 0",
    verticalAlign: "middle",
    width: "40%",
    textAlign: "right",
  };
  return h(
    "table",
    {
      role: "presentation",
      cellPadding: "0",
      cellSpacing: "0",
      border: "0",
      style: tableStyle,
    },
    h(
      "tbody",
      null,
      h(
        "tr",
        null,
        h(
          "td",
          { style: cellLeftStyle, valign: "middle" },
          // Email logo: viewix-logo-email.png is 278x74 natural,
          // displayed at 139x37. Half-scale matches retina 2x
          // density so the logo stays crisp.
          h("img", {
            src: brandLogoUrl(),
            alt: "Viewix",
            width: "139",
            height: "37",
            style: {
              display: "block",
              width: "139px",
              height: "37px",
              border: "0",
            },
          })
        ),
        h(
          "td",
          { style: cellRightStyle, valign: "middle" },
          h(
            "span",
            {
              style: {
                fontFamily: FONT_MONO,
                fontSize: "10px",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: BRAND.inkMuted,
                whiteSpace: "nowrap",
              },
            },
            "Client update"
          )
        )
      )
    )
  );
}

// ────────────────────────────────────────────────────────────────
// Stepper — "STAGE X OF 4" + 4 dots + labels with a connector line.
//
// Behaviour: the accent (blue) progress line stops at the centre of
// the current-stage dot. Upcoming dots are filled gray and show
// their stage number so the client always sees all four steps.
//
// Done stages:      blue filled dot with ✓
// Current stage:    blue filled dot with the stage number
// Upcoming stages:  gray filled dot with the stage number
//
// Implementation note 2026-05-12 (post-canary, locked in PR #113):
// The earlier two-row layout used `marginTop: -12px` to pull each
// dot up into a separate line row. Gmail Web strips negative
// margins, so the dot stayed below the line — confirmed live in the
// first production canary send. Pure HTML-table geometry now: the
// line halves and the dot share one row of a nested per-stage
// table, all valign="middle". Forbidden constructs: negative
// margins, position:absolute/relative, transform, calc(),
// margin:auto, background-image, gradients. Tables stay dumb.
function Stepper({ stage, accent }) {
  const accentColor = accent === "orange" ? BRAND.orange : BRAND.blue;
  const lineColorDone = accentColor;
  const lineColorUpcoming = BRAND.borderStrong;

  // 2px-tall line bar. backgroundColor only. NBSP keeps the div
  // from collapsing in clients that aggressively strip empty divs.
  const lineBar = (color) =>
    h(
      "div",
      {
        style: {
          height: "2px",
          lineHeight: "2px",
          fontSize: "0",
          backgroundColor: color,
          width: "100%",
        },
      },
      " "
    );

  // Dot. No marginTop, no position offset. Sits at the natural
  // vertical centre of its td (valign=middle).
  const renderDot = (s) => {
    const isDone = s.num < stage;
    const isUpcoming = s.num > stage;
    const dotFill = isUpcoming ? BRAND.gray : accentColor;
    const dotBorder = isUpcoming
      ? `2px solid ${BRAND.gray}`
      : `2px solid ${accentColor}`;
    const dotChar = isDone ? "✓" : String(s.num);
    return h(
      "div",
      {
        style: {
          width: "22px",
          height: "22px",
          lineHeight: "18px",
          borderRadius: "50%",
          background: dotFill,
          border: dotBorder,
          color: BRAND.panel,
          fontFamily: FONT_BODY,
          fontWeight: 700,
          fontSize: "11px",
          textAlign: "center",
          display: "inline-block",
        },
      },
      dotChar
    );
  };

  // One stage column. Raw <table> because we need cellPadding=0,
  // cellSpacing=0, border=0 HTML attributes plus a colspan row
  // for the label — React Email's Row/Column don't pass those
  // through cleanly.
  const stageColumn = (s) => {
    const isCurrent = s.num === stage;
    const isDone = s.num < stage;
    const leftColor = s.num <= stage ? lineColorDone : lineColorUpcoming;
    const rightColor = s.num < stage ? lineColorDone : lineColorUpcoming;
    const labelColor = isCurrent ? BRAND.ink : (isDone ? BRAND.inkSoft : BRAND.inkMuted);
    const labelWeight = isCurrent ? 700 : 500;

    return h(
      "td",
      {
        key: s.num,
        width: "25%",
        align: "center",
        valign: "middle",
        style: { width: "25%", padding: 0, verticalAlign: "middle" },
      },
      h(
        "table",
        {
          cellPadding: "0",
          cellSpacing: "0",
          border: "0",
          width: "100%",
          style: { borderCollapse: "collapse", width: "100%" },
        },
        h(
          "tbody",
          null,
          h(
            "tr",
            null,
            h(
              "td",
              {
                valign: "middle",
                style: { verticalAlign: "middle", padding: 0 },
              },
              lineBar(leftColor)
            ),
            h(
              "td",
              {
                width: "22",
                valign: "middle",
                style: {
                  width: "22px",
                  padding: 0,
                  verticalAlign: "middle",
                  textAlign: "center",
                  lineHeight: 0,
                  fontSize: 0,
                },
              },
              renderDot(s)
            ),
            h(
              "td",
              {
                valign: "middle",
                style: { verticalAlign: "middle", padding: 0 },
              },
              lineBar(rightColor)
            )
          ),
          h(
            "tr",
            null,
            h(
              "td",
              {
                colSpan: 3,
                align: "center",
                style: {
                  textAlign: "center",
                  paddingTop: "10px",
                  fontFamily: FONT_BODY,
                  fontSize: "12px",
                  color: labelColor,
                  fontWeight: labelWeight,
                  lineHeight: 1.3,
                },
              },
              s.label
            )
          )
        )
      )
    );
  };

  return h(
    Section,
    { style: styles.stepperWrap },
    h(
      Row,
      { style: styles.stepperMetaRow },
      h(
        Column,
        { style: { width: "100%", textAlign: "left" } },
        h("span", { style: { fontFamily: FONT_MONO } }, `Stage ${stage} of 4`)
      )
    ),
    h(
      "table",
      {
        cellPadding: "0",
        cellSpacing: "0",
        border: "0",
        width: "100%",
        style: {
          width: "100%",
          borderCollapse: "collapse",
          marginTop: "12px",
        },
      },
      h(
        "tbody",
        null,
        h("tr", null, ...STAGES.map(stageColumn))
      )
    )
  );
}


// ────────────────────────────────────────────────────────────────
// PersonChip — circular avatar with initials, name, role.
// ────────────────────────────────────────────────────────────────
// Display AU mobile numbers in the conventional "0477 515 963" form.
// Falls back to the raw stored string for anything that doesn't match
// the 04XXXXXXXX shape (international, landlines, free-form, etc.).
function formatPhoneAU(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/[^\d]/g, "");
  if (/^04\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return String(raw).trim();
}

function PersonChip({ person, accent }) {
  if (!person || !person.name) return null;
  const accentColor = accent === "orange" ? BRAND.orange : BRAND.blue;
  const initials =
    (person.initials || "").trim() ||
    (person.name || "")
      .trim()
      .split(/\s+/)
      .map(w => w.charAt(0))
      .slice(0, 2)
      .join("")
      .toUpperCase();
  // Avatar URL takes priority over initials. Slack profile photos
  // (https://ca.slack-edge.com/...) are square; we crop to a circle
  // with border-radius. Falls back to initials disk when no avatar
  // URL is provided.
  const avatarUrl = person.avatar || person.avatarUrl || null;
  const avatarNode = avatarUrl
    ? h("img", {
        src: avatarUrl,
        alt: person.name,
        width: 32,
        height: 32,
        style: {
          display: "block",
          width: "32px",
          height: "32px",
          borderRadius: "50%",
          border: "0",
          objectFit: "cover",
        },
      })
    : h(
        "div",
        {
          style: {
            width: "32px",
            height: "32px",
            lineHeight: "32px",
            borderRadius: "50%",
            background: accentColor,
            color: BRAND.panel,
            fontFamily: FONT_DISPLAY,
            fontWeight: 700,
            fontSize: "11px",
            letterSpacing: "0.02em",
            textAlign: "center",
          },
        },
        initials
      );
  return h(
    Column,
    { style: { verticalAlign: "middle", paddingRight: "10px" } },
    h(
      Row,
      null,
      h(
        Column,
        { style: { width: "32px", verticalAlign: "middle", lineHeight: 0 } },
        avatarNode
      ),
      h(
        Column,
        { style: { verticalAlign: "middle", paddingLeft: "9px" } },
        h(
          Text,
          {
            style: {
              fontSize: "12px",
              fontWeight: 600,
              color: BRAND.ink,
              margin: 0,
              lineHeight: 1.3,
            },
          },
          person.name
        ),
        h(
          Text,
          {
            style: {
              fontSize: "10.5px",
              color: BRAND.inkMuted,
              fontFamily: FONT_MONO,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              margin: 0,
              lineHeight: 1.3,
            },
          },
          person.role || ""
        ),
        // Mobile number line — per Jeremy 2026-05-12, the account
        // manager's mobile must always appear in the chip so the
        // client has a direct escalation channel on every touchpoint.
        // Rendered as a tel: link for one-tap dialling on mobile;
        // mailto-style fallbacks gracefully if the email client
        // strips the href (the number text remains).
        person.phone
          ? h(
              Text,
              {
                style: {
                  fontSize: "11px",
                  color: BRAND.inkSoft,
                  margin: "2px 0 0",
                  lineHeight: 1.3,
                  fontVariantNumeric: "tabular-nums",
                },
              },
              h(
                "a",
                {
                  href: `tel:${String(person.phone).replace(/[^\d+]/g, "")}`,
                  style: { color: BRAND.inkSoft, textDecoration: "none" },
                },
                formatPhoneAU(person.phone)
              )
            )
          : null
      )
    )
  );
}

// ────────────────────────────────────────────────────────────────
// ProjectCard — project name + subtitle + producer / editor chips.
// Chips only render when their person data is present (name set).
// ────────────────────────────────────────────────────────────────
function ProjectCard({ project, producer, editor, accent }) {
  if (!project) return null;
  const hasAnyChip = (producer && producer.name) || (editor && editor.name);
  return h(
    Section,
    { style: styles.projectCardWrap },
    h(
      "div",
      { style: styles.projectCard },
      h(Text, { style: styles.projectCardEyebrow }, "Project"),
      h(Text, { style: styles.projectCardName }, project.projectName || "Untitled project"),
      project.clientName
        ? h(Text, { style: styles.projectCardSub }, project.clientName)
        : null,
      hasAnyChip
        ? h(
            "div",
            { style: styles.chipsRow },
            h(
              Row,
              null,
              producer ? h(PersonChip, { person: producer, accent }) : null,
              editor ? h(PersonChip, { person: editor, accent }) : null
            )
          )
        : null
    )
  );
}

// ────────────────────────────────────────────────────────────────
// UpNext — eyebrow divider + next-step text.
// ────────────────────────────────────────────────────────────────
function UpNext({ text }) {
  if (!text) return null;
  return h(
    "div",
    null,
    h(
      Section,
      { style: styles.upNextRow },
      h(
        Row,
        null,
        h(
          Column,
          { style: { width: "70px", verticalAlign: "middle" } },
          h(Text, { style: styles.upNextEyebrow }, "Up next")
        ),
        h(
          Column,
          { style: { verticalAlign: "middle", paddingLeft: "10px" } },
          h(Hr, { style: styles.upNextHr })
        )
      )
    ),
    h(Text, { style: styles.upNextText }, `→ ${text}`)
  );
}

// ────────────────────────────────────────────────────────────────
// HeroImagery — optional per-stage decorative block between the hero
// text and the project card. Keep disabled unless the referenced PNGs
// have actually been committed and deployed; otherwise email clients
// show broken-image boxes.
// ────────────────────────────────────────────────────────────────
function HeroImagery({ stage }) {
  const url = heroImageUrl(stage);
  if (!url) return null;
  const altByStage = {
    1: "Kickoff — your project is loaded into the studio",
    2: "On location — REC 00:12:04:17",
    3: "In the edit suite — timeline waveform",
    4: "Ready for review — first cut",
  };
  return h(
    Section,
    { style: { padding: "4px 28px 20px" } },
    h(
      "div",
      { style: { borderRadius: "12px", overflow: "hidden", lineHeight: 0 } },
      h("img", {
        src: url,
        alt: altByStage[stage] || "",
        width: "480",
        height: "140",
        style: {
          display: "block",
          width: "100%",
          maxWidth: "480px",
          height: "auto",
          border: "0",
          outline: "none",
          textDecoration: "none",
        },
      })
    )
  );
}

// ────────────────────────────────────────────────────────────────
// Footer link — only shown when the hero block didn't have a CTA.
// "View project on dashboard ->" small-cap link.
// ────────────────────────────────────────────────────────────────
function FooterDashboardLink({ url, accent }) {
  if (!url) return null;
  const accentColor = accent === "orange" ? BRAND.orange : BRAND.blue;
  return h(
    Section,
    { style: styles.footerLinkWrap },
    h(
      Link,
      {
        href: url,
        style: { ...styles.footerLink, color: accentColor },
      },
      "View project on dashboard →"
    )
  );
}

// ────────────────────────────────────────────────────────────────
// Brand footer — "The Viewix team" + viewix.com.au, on tinted bg.
// ────────────────────────────────────────────────────────────────
function BrandFooter() {
  return h(
    Section,
    { style: styles.footer },
    h(Text, { style: styles.footerByline }, "The Viewix team"),
    h(Text, { style: styles.footerDomain }, "viewix.com.au")
  );
}

// ────────────────────────────────────────────────────────────────
// Main layout. Templates pass their stage number + hero content
// (children), plus optional project/producer/editor/upNext/dashboardUrl.
//
// Args:
//   stage:      1-4. Drives the stepper highlight and the "up next" default.
//   preview:    inbox preview text (60-120 chars).
//   accent:     "blue" | "orange". Defaults to "blue" (Viewix primary).
//   project:    { id, projectName, clientName, ... }
//   client:     { firstName, email } — not rendered directly; templates
//               use it in their hero body copy.
//   producer:   optional { name, role, initials }
//   editor:     optional { name, role, initials }
//   upNext:     optional override text. Defaults to STAGES[stage-1].next.
//   dashboardUrl: optional URL. If set AND the hero block has no CTA,
//               renders the "View project on dashboard ->" footer link.
//   children:   the hero block — eyebrow + headline + body + optional
//               in-hero CTA. Each template renders its own.
//   hasInHeroCta: signals to the layout that the hero rendered its own
//               CTA, so the footer dashboard link should be suppressed
//               to avoid two CTAs in the same email.
// ────────────────────────────────────────────────────────────────
export function Layout({
  stage,
  preview,
  accent = "blue",
  project,
  producer,
  editor,
  upNext,
  dashboardUrl,
  hasInHeroCta = false,
  showImagery = false,
  children,
}) {
  const stageInfo = STAGES.find(s => s.num === stage) || STAGES[0];
  const resolvedUpNext = (upNext != null ? upNext : stageInfo.next) || "";

  return h(
    Html,
    { lang: "en" },
    h(
      Head,
      null,
      h(Font, {
        fontFamily: "Inter",
        fallbackFontFamily: ["Helvetica", "Arial", "sans-serif"],
        webFont: {
          url: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuLyfMZg.woff2",
          format: "woff2",
        },
        fontWeight: 400,
        fontStyle: "normal",
      }),
      h(Font, {
        fontFamily: "Montserrat",
        fallbackFontFamily: ["Helvetica", "Arial", "sans-serif"],
        webFont: {
          url: "https://fonts.gstatic.com/s/montserrat/v30/JTUSjIg1_i6t8kCHKm459Wlhyw.woff2",
          format: "woff2",
        },
        fontWeight: 800,
        fontStyle: "normal",
      })
    ),
    h(Preview, null, preview || ""),
    h(
      Body,
      { style: styles.body },
      h(
        Section,
        { style: styles.outerWrap },
        h(
          Container,
          { style: styles.card },
          h(EmailHeader, null),
          h(Stepper, { stage, accent }),
          // Hero block — template-specific
          h(Section, { style: styles.hero }, children),
          // Per-stage hero imagery (Kickoff = blue gradient/play, Shoot
          // = REC indicator, Edit = timeline waveform, Review = circle
          // play + progress bar). Lives between the hero text block and
          // the project card. Hidden gracefully if showImagery is false
          // (no <img> rendered at all, so no broken-image icon).
          showImagery !== false
            ? h(HeroImagery, { stage })
            : null,
          // Project card
          h(ProjectCard, { project, producer, editor, accent }),
          // Up next
          h(UpNext, { text: resolvedUpNext }),
          // Footer dashboard link (only when no in-hero CTA)
          !hasInHeroCta && dashboardUrl
            ? h(FooterDashboardLink, { url: dashboardUrl, accent })
            : null,
          h(BrandFooter, null)
        )
      )
    )
  );
}

// Helper exports so the per-template files can render their hero blocks
// using the same heading / body / eyebrow / CTA styles. Templates can
// also reach into BRAND for any one-off colour need.
export const heroStyles = {
  eyebrow: (accent) =>
    ({ ...styles.heroEyebrow, color: accent === "orange" ? BRAND.orange : BRAND.blue }),
  headline: styles.heroHeadline,
  body: styles.heroBody,
  cta: (accent) =>
    ({ ...styles.ctaButton, background: accent === "orange" ? BRAND.orange : BRAND.blue }),
};

export default Layout;
