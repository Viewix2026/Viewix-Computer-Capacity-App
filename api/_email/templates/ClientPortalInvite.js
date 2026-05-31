// api/_email/templates/ClientPortalInvite.js
// Transactional invite — NOT a lifecycle stage.
//
// Fires from api/admin-client-access.js when a founder grants a client
// email access to a specific org (Accounts → Client portal access).
// One invite per (accountId, emailKey); re-grants are silent (see
// sendClientPortalInvite.js idempotency key). A manual "Resend invite"
// in the staff UI clears the lock and re-fires.
//
// Reuses the shared Layout chrome (header, footer, fonts, BRAND tokens)
// but switches OFF the three lifecycle rails — stepper, project card,
// and "up next" — via the opt-out flags added to _layout.js. The result
// is the same branded card without the Kickoff→Review progress framing,
// which would be meaningless for an account-level access invite.
//
// Reply-to remains hello@viewix.com.au for v1 (send.js is untouched).
// The account manager appears as a VISUAL signature only — name, photo,
// a mailto: link, and an optional booking button. It is not the
// technical from/reply-to.
//
// Props:
//   firstName       client's first name (falls back to "there")
//   companyName     the org being granted access (names the invite)
//   accountManager  { name, photo, phone, email, bookingUrl } from
//                   _clientRedact.js accountManagerBlock(); any field
//                   may be empty. If name is empty we render a generic
//                   Viewix Studio sign-off instead.
//   signInUrl       https://planner.viewix.com.au/clients/ — CTA target
//   accent          "blue" | "orange" (defaults to "blue")

import { h } from "../_h.js";
import { Button, Heading, Hr, Link, Text } from "@react-email/components";
import { BRAND, Layout, heroStyles } from "./_layout.js";

const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const FONT_DISPLAY = "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const SUPPORT_EMAIL = "hello@viewix.com.au";

const styles = {
  // Signature sits below the CTA, separated by a hairline rule.
  sigWrap: {
    margin: "28px 0 4px",
  },
  sigHr: {
    borderTop: `1px solid ${BRAND.borderMid}`,
    margin: "0 0 18px",
    width: "100%",
  },
  sigLabel: {
    fontFamily: FONT_MONO,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontSize: "10px",
    color: BRAND.inkMuted,
    margin: "0 0 12px",
  },
  sigName: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: "14px",
    color: BRAND.ink,
    margin: 0,
    lineHeight: 1.3,
  },
  sigRole: {
    fontFamily: FONT_MONO,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontSize: "10.5px",
    color: BRAND.inkMuted,
    margin: "2px 0 0",
    lineHeight: 1.3,
  },
  sigEmailRow: {
    margin: "8px 0 0",
    fontSize: "12px",
    color: BRAND.inkSoft,
    lineHeight: 1.4,
  },
  sigEmailLink: {
    color: BRAND.inkSoft,
    textDecoration: "none",
  },
  bookingButton: {
    display: "inline-block",
    marginTop: "14px",
    padding: "9px 14px",
    borderRadius: "8px",
    border: `1px solid ${BRAND.borderStrong}`,
    backgroundColor: BRAND.panel,
    fontFamily: FONT_DISPLAY,
    fontWeight: 600,
    fontSize: "12.5px",
    color: BRAND.ink,
    textDecoration: "none",
  },
};

// Circular avatar (photo) or initials disk — mirrors PersonChip in
// _layout.js but standalone so the signature can size it larger.
function avatarNode(am, accentColor) {
  const photo = am?.photo || am?.avatar || am?.avatarUrl || null;
  if (photo) {
    return h("img", {
      src: photo,
      alt: am.name,
      width: 40,
      height: 40,
      style: {
        display: "block",
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        border: "0",
        objectFit: "cover",
      },
    });
  }
  const initials = (am?.name || "")
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return h(
    "div",
    {
      style: {
        width: "40px",
        height: "40px",
        lineHeight: "40px",
        borderRadius: "50%",
        background: accentColor,
        color: BRAND.panel,
        fontFamily: FONT_DISPLAY,
        fontWeight: 700,
        fontSize: "13px",
        letterSpacing: "0.02em",
        textAlign: "center",
      },
    },
    initials || "V"
  );
}

// Signature block. When a real AM resolved (name present) render their
// photo + name + role + mailto + optional booking button. Otherwise a
// generic Viewix Studio sign-off pointing at hello@viewix.com.au.
function Signature({ accountManager, accent }) {
  const accentColor = accent === "orange" ? BRAND.orange : BRAND.blue;
  const am = accountManager || {};
  const hasAm = !!(am.name && String(am.name).trim());

  if (!hasAm) {
    return h(
      "div",
      { style: styles.sigWrap },
      h(Hr, { style: styles.sigHr }),
      h(Text, { style: styles.sigLabel }, "Your Viewix team"),
      h(Text, { style: styles.sigName }, "The Viewix Studio"),
      h(
        Text,
        { style: styles.sigEmailRow },
        "Questions? Reach us at ",
        h(
          Link,
          { href: `mailto:${SUPPORT_EMAIL}`, style: styles.sigEmailLink },
          SUPPORT_EMAIL
        )
      )
    );
  }

  const amEmail = (am.email || "").trim();
  const bookingUrl = (am.bookingUrl || "").trim();

  return h(
    "div",
    { style: styles.sigWrap },
    h(Hr, { style: styles.sigHr }),
    h(Text, { style: styles.sigLabel }, "Your account manager"),
    // Avatar + name/role as a two-column table row (Outlook-safe).
    h(
      "table",
      {
        role: "presentation",
        cellPadding: "0",
        cellSpacing: "0",
        border: "0",
        style: { borderCollapse: "collapse" },
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
              style: { verticalAlign: "middle", width: "40px", lineHeight: 0 },
            },
            avatarNode(am, accentColor)
          ),
          h(
            "td",
            {
              valign: "middle",
              style: { verticalAlign: "middle", paddingLeft: "12px" },
            },
            h(Text, { style: styles.sigName }, am.name),
            h(Text, { style: styles.sigRole }, "Your Account Manager")
          )
        )
      )
    ),
    amEmail
      ? h(
          Text,
          { style: styles.sigEmailRow },
          h(
            Link,
            { href: `mailto:${amEmail}`, style: styles.sigEmailLink },
            amEmail
          )
        )
      : null,
    bookingUrl
      ? h(
          Button,
          { href: bookingUrl, style: styles.bookingButton },
          "Book a time to chat"
        )
      : null
  );
}

export default function ClientPortalInvite(props) {
  const firstName = props?.firstName || "there";
  const companyName = (props?.companyName || "").trim();
  const accent = props?.accent || "blue";
  const signInUrl = props?.signInUrl || "";
  const accountManager = props?.accountManager || null;

  // Body names the org when known; stays natural when it doesn't.
  const orgPhrase = companyName ? `${companyName}'s` : "your";
  const bodyCopy =
    `You've been given access to ${orgPhrase} Viewix client portal. ` +
    "Sign in any time to watch your videos, leave timestamped notes, " +
    "approve cuts, and see what's coming up next. " +
    "There's no password to remember - just enter this email address " +
    "and we'll send you a one-tap sign-in link.";

  return h(
    Layout,
    {
      // Not a lifecycle stage — switch off the stepper, project card,
      // and "up next" rails. stage is irrelevant with the stepper off
      // but the Layout falls back to STAGES[0] safely.
      preview: companyName
        ? `${firstName}, your invite to ${companyName}'s Viewix portal.`
        : `${firstName}, your Viewix client portal invite.`,
      accent,
      showStepper: false,
      showProjectCard: false,
      showUpNext: false,
      // In-hero CTA carries the link; suppress any footer dashboard link.
      hasInHeroCta: true,
      dashboardUrl: null,
    },
    h(Text, { style: heroStyles.eyebrow(accent) }, "Client portal"),
    h(
      Heading,
      { as: "h1", style: heroStyles.headline },
      "You're invited"
    ),
    h(Text, { style: heroStyles.body }, `Hi ${firstName}, ${bodyCopy}`),

    // Primary CTA → the /clients/ sign-in screen. Resend renders Button
    // as a bulletproof table-based button (Outlook-safe). The calling
    // wrapper guards on signInUrl being present, so this should always
    // render in practice.
    signInUrl
      ? h(
          Button,
          { href: signInUrl, style: heroStyles.cta(accent) },
          "Open your portal"
        )
      : null,

    // AM (or generic Viewix) visual signature.
    h(Signature, { accountManager, accent })
  );
}
