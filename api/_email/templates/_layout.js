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

// Brand variables. Sourced from the design's data and the Viewix brand
// guidelines (page 1 of the PDF Jeremy uploaded). Blue is the primary
// accent; orange is alternate. Phase B keeps these centralised so a
// theme switch is a one-place edit.
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

// Email-safe font stack. Inter + Montserrat are loaded from Google Fonts
// CDN at the top of every email. Outlook desktop strips webfont
// @font-face — the system fallbacks must form a sensible stack on their
// own there. JetBrains Mono is used for eyebrow / label text; we don't
// load it via webfont (rare client support) and rely on the monospace
// fallback (Courier, Menlo) where it matters.
const FONT_BODY    = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_DISPLAY = "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO    = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Logo: served from the deployed dashboard's /public folder.
// Re-uses the existing /public/viewix-logo.png (already in repo).
// Resend + most inbox renderers fetch this remotely. If
// PUBLIC_BASE_URL is unset we fall back to a relative path which
// won't load — better than embedding a base64 PNG bloat in every
// email.
function brandLogoUrl() {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/viewix-logo.png` : "/viewix-logo.png";
}

// The 4 lifecycle stages, in order. Stage 1 = Kickoff (Confirmation),
// Stage 2 = Shooting (ShootTomorrow), Stage 3 = Editing (InEditSuite),
// Stage 4 = Review (ReadyForReview). Labels and the "next up" lines
// match the design's STAGES array verbatim, with hyphens not em dashes.
const STAGES = [
  { num: 1, label: "Kickoff",  next: "Producer call & shoot scheduling" },
  { num: 2, label: "Shooting", next: "Footage ingest & first edit pass" },
  { num: 3, label: "Editing",  next: "First cut ready for your review" },
  { num: 4, label: "Review",   next: "Apply your notes & finalise" },
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
  header: {
    padding: "22px 28px",
    borderBottom: `1px solid ${BRAND.borderLight}`,
  },
  logoImg: {
    height: "24px",
    width: "auto",
    display: "block",
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
// Uses a Row/Column pair so Outlook lays it out as a table row.
// ────────────────────────────────────────────────────────────────
function EmailHeader() {
  return h(
    Section,
    { style: styles.header },
    h(
      Row,
      null,
      h(
        Column,
        { style: { width: "60%", verticalAlign: "middle" } },
        h(Img, {
          src: brandLogoUrl(),
          alt: "Viewix",
          width: "84",
          style: styles.logoImg,
        })
      ),
      h(
        Column,
        { style: { width: "40%", verticalAlign: "middle" } },
        h(Text, { style: styles.headerEyebrow }, "Client update")
      )
    )
  );
}

// ────────────────────────────────────────────────────────────────
// Stepper — "STAGE X OF 4" + project ID, then 4 dots + labels.
//
// Done stages render as a filled accent dot with ✓.
// Current stage renders as a filled accent dot with the stage number.
// Upcoming stages render as a white dot with a gray border.
//
// The connecting line from the design is dropped — it's an absolute-
// position overlay that doesn't translate to email tables. The dot
// row + labels carry the sequence information on their own.
// ────────────────────────────────────────────────────────────────
function Stepper({ stage, accent, projectId }) {
  const accentColor = accent === "orange" ? BRAND.orange : BRAND.blue;
  return h(
    Section,
    { style: styles.stepperWrap },
    // Meta row: "STAGE X OF 4" + project ID
    h(
      Row,
      { style: styles.stepperMetaRow },
      h(
        Column,
        { style: { width: "50%", textAlign: "left" } },
        h("span", { style: { fontFamily: FONT_MONO } }, `Stage ${stage} of 4`)
      ),
      h(
        Column,
        { style: { width: "50%", textAlign: "right" } },
        projectId
          ? h("span", { style: { fontFamily: FONT_MONO } }, projectId)
          : null
      )
    ),
    // Dot row + labels — one column per stage
    h(
      Row,
      null,
      ...STAGES.map(s => {
        const isDone = s.num < stage;
        const isCurrent = s.num === stage;
        const dotFill = isDone || isCurrent ? accentColor : BRAND.panel;
        const dotBorder = isDone || isCurrent ? `2px solid ${accentColor}` : `2px solid ${BRAND.borderStrong}`;
        const dotChar = isDone ? "✓" : (isCurrent ? String(s.num) : "");
        const dotColor = isDone || isCurrent ? BRAND.panel : BRAND.inkMuted;
        const labelColor = isCurrent ? BRAND.ink : (isDone ? BRAND.inkSoft : BRAND.inkMuted);
        const labelWeight = isCurrent ? 700 : 500;
        return h(
          Column,
          {
            key: s.num,
            style: { width: "25%", textAlign: "center", verticalAlign: "top" },
          },
          h(
            "div",
            {
              style: {
                display: "inline-block",
                width: "22px",
                height: "22px",
                lineHeight: "22px",
                borderRadius: "50%",
                background: dotFill,
                border: dotBorder,
                color: dotColor,
                fontFamily: FONT_BODY,
                fontWeight: 700,
                fontSize: "11px",
                textAlign: "center",
              },
            },
            dotChar
          ),
          h(
            Text,
            {
              style: {
                ...styles.stepperLabel,
                color: labelColor,
                fontWeight: labelWeight,
              },
            },
            s.label
          )
        );
      })
    )
  );
}

// ────────────────────────────────────────────────────────────────
// PersonChip — circular avatar with initials, name, role.
// ────────────────────────────────────────────────────────────────
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
  return h(
    Column,
    { style: { verticalAlign: "middle", paddingRight: "10px" } },
    h(
      Row,
      null,
      h(
        Column,
        { style: { width: "32px", verticalAlign: "middle" } },
        h(
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
        )
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
        )
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
          h(Stepper, {
            stage,
            accent,
            projectId: project?.shortId || project?.id || null,
          }),
          // Hero block — template-specific
          h(Section, { style: styles.hero }, children),
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
