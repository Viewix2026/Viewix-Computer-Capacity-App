// api/_email/templates/_layout.js
// Shared chrome for every Phase A placeholder template:
//   - <Html> wrapper with preview text + Inter font CDN
//   - Header with Viewix wordmark
//   - Body container with brand background
//   - Footer with the standard "reply hits a real human" line
//
// Phase B (real designs) will likely refactor or replace this layout
// to match Claude Design's actual visual treatment. For now this is
// deliberately ugly-but-on-brand so dry-run sanity checks confirm
// the wiring works without anyone mistaking a placeholder for the
// finished product.

import { h } from "../_h.js";
import {
  Body,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// Brand variables sourced from the Claude Design viewer shell.
// Centralised here so every template (and the Phase B redesign)
// references one source of truth.
export const BRAND = {
  blue: "#0082FA",
  blueDark: "#004F99",
  orange: "#F87700",
  orangeDark: "#AE3A00",
  off: "#F4F5F9",
  gray: "#CBCCD1",
  ink: "#0B0D12",
  panel: "#FFFFFF",
  bg: "#EEF0F4",
  inkSoft: "#4A4F5C",
  inkSofter: "#6B7180",
};

// Email-safe font stack. Outlook desktop strips webfont @font-face,
// so the fallbacks must form a sensible system stack on their own.
const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_HEAD = "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const styles = {
  body: {
    backgroundColor: BRAND.bg,
    color: BRAND.ink,
    fontFamily: FONT_BODY,
    margin: 0,
    padding: 0,
  },
  outerWrap: {
    backgroundColor: BRAND.bg,
    padding: "32px 16px",
  },
  card: {
    backgroundColor: BRAND.panel,
    borderRadius: "16px",
    maxWidth: "560px",
    margin: "0 auto",
    overflow: "hidden",
    boxShadow: "0 1px 0 rgba(0,0,0,0.04), 0 12px 28px -16px rgba(12,16,24,0.18)",
  },
  header: {
    backgroundColor: BRAND.ink,
    padding: "24px 28px",
  },
  brand: {
    color: BRAND.panel,
    fontFamily: FONT_HEAD,
    fontWeight: 800,
    fontSize: "20px",
    letterSpacing: "-0.01em",
    margin: 0,
  },
  brandTagline: {
    color: BRAND.gray,
    fontSize: "12px",
    margin: "4px 0 0",
  },
  content: {
    padding: "32px 28px 12px",
  },
  footer: {
    padding: "16px 28px 28px",
    color: BRAND.inkSofter,
    fontSize: "12px",
    lineHeight: 1.55,
  },
  hr: {
    borderColor: BRAND.off,
    margin: "20px 0 16px",
  },
};

/**
 * Render a child node tree inside the standard Viewix shell.
 * @param {object} args
 * @param {string} args.preview      - 80–120 char preview text shown in inbox lists
 * @param {string} args.title        - On-brand title shown in the dark header
 * @param {React.ReactNode} args.children - Body content to render between header and footer
 */
export function Layout({ preview, title, children }) {
  return h(
    Html,
    { lang: "en" },
    h(
      Head,
      null,
      h(Font, {
        fontFamily: "Inter",
        fallbackFontFamily: ["Helvetica", "Arial", "sans-serif"],
        webFont: { url: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50ojIw2boKoduKmMEVuLyfMZg.woff2", format: "woff2" },
        fontWeight: 400,
        fontStyle: "normal",
      }),
      h(Font, {
        fontFamily: "Montserrat",
        fallbackFontFamily: ["Helvetica", "Arial", "sans-serif"],
        webFont: { url: "https://fonts.gstatic.com/s/montserrat/v30/JTUSjIg1_i6t8kCHKm459Wlhyw.woff2", format: "woff2" },
        fontWeight: 700,
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
          h(
            Section,
            { style: styles.header },
            h(Heading, { as: "h1", style: styles.brand }, "VIEWIX"),
            title ? h(Text, { style: styles.brandTagline }, title) : null
          ),
          h(Section, { style: styles.content }, children),
          h(Hr, { style: styles.hr }),
          h(
            Section,
            { style: styles.footer },
            h(Text, { style: { margin: 0 } }, "Hit reply on this email and a real human at Viewix will read it. We're at hello@viewix.com.au."),
            h(Text, { style: { margin: "10px 0 0", color: BRAND.gray } }, "Viewix Video Production · Sydney, Australia")
          )
        )
      )
    )
  );
}

export default Layout;
