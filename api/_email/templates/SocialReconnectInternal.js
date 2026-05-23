// api/_email/templates/SocialReconnectInternal.js
//
// INTERNAL email — sent to the project lead (Viewix team member) when
// a non-TikTok account's auth token has dropped. The team member
// opens the Zernio hosted connect URL while logged into the Viewix
// Facebook / Google / LinkedIn account that holds Leadsie-granted
// admin access on the client's assets. Selects the client's IG / FB
// Page / YT channel / LinkedIn Page in the consent picker, approves,
// done — client never sees this.
//
// Subject (in caller): "Reconnect needed: {{accountName}} {{platform}}"
//
// Merge tags:
//   accountName    — the Viewix client whose social just dropped
//   platform       — "instagram" | "facebook" | "youtube" | "linkedin"
//   reconnectUrl   — Zernio hosted JWT link
//   accountId      — Viewix internal id for cross-reference

import { h } from "../_h.js";
import {
  Body, Button, Container, Head, Heading,
  Html, Preview, Section, Text,
} from "@react-email/components";

const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const PLATFORM_LABEL = {
  instagram: "Instagram",
  facebook:  "Facebook Page",
  youtube:   "YouTube",
  linkedin:  "LinkedIn Page",
};

export default function SocialReconnectInternal(props) {
  const accountName = props?.accountName || "(unknown account)";
  const platform = props?.platform || "instagram";
  const platformLabel = PLATFORM_LABEL[platform] || platform;
  const reconnectUrl = props?.reconnectUrl || "#";
  const accountId = props?.accountId || "(unknown)";

  return h(
    Html,
    {},
    h(Head, {}),
    h(Preview, {}, `Reconnect ${platformLabel} for ${accountName} — open this link while logged into the Viewix Business Manager.`),
    h(
      Body,
      { style: { backgroundColor: "#EEF0F4", margin: 0, padding: "32px 16px", fontFamily: FONT_BODY } },
      h(
        Container,
        { style: { backgroundColor: "#FFFFFF", borderRadius: 12, maxWidth: 560, margin: "0 auto", padding: "32px 28px" } },
        h(
          Heading,
          { as: "h1", style: { fontSize: 20, fontWeight: 700, color: "#0B0D12", margin: "0 0 12px" } },
          `Reconnect ${platformLabel} — ${accountName}`
        ),
        h(
          Text,
          { style: { fontSize: 14, color: "#3A3F4C", lineHeight: 1.55, margin: "0 0 16px" } },
          `${accountName}'s ${platformLabel} connection just dropped. Open the link below while logged into the Viewix Business Manager — you'll see ${accountName}'s asset in the consent picker. Approve and it's restored.`
        ),
        h(
          Section,
          { style: { textAlign: "center", margin: "24px 0" } },
          h(
            Button,
            {
              href: reconnectUrl,
              style: {
                backgroundColor: "#0082FA", color: "#FFFFFF",
                padding: "12px 24px", borderRadius: 8,
                fontSize: 14, fontWeight: 600, textDecoration: "none",
                display: "inline-block",
              },
            },
            `Open reconnect link →`
          )
        ),
        h(
          Text,
          { style: { fontSize: 12, color: "#6B7180", lineHeight: 1.5, margin: "16px 0 0", fontFamily: FONT_MONO } },
          `accountId: ${accountId} · platform: ${platform}`
        ),
        h(
          Text,
          { style: { fontSize: 12, color: "#9AA0AE", lineHeight: 1.5, margin: "20px 0 0", borderTop: "1px solid #EEF0F4", paddingTop: 16 } },
          "Internal — sent because Leadsie BM access lets Viewix self-link Meta/YT/LinkedIn. (TikTok always goes to the client direct.)"
        )
      )
    )
  );
}
