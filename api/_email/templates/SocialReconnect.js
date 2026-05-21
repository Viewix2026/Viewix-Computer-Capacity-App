// api/_email/templates/SocialReconnect.js
//
// Client-facing email when a TikTok account's auth token has dropped
// (Zernio webhook account.disconnected event). TikTok is the only
// platform where the client MUST reauthorize themselves — Leadsie BM
// access doesn't broker the TikTok Content Posting API consent flow.
// For Meta/YouTube/LinkedIn, the Viewix team handles the reconnect
// using Leadsie-granted access and we send the *internal* template
// instead (SocialReconnectInternal.js).
//
// Subject (in caller): "Quick reconnect needed for your TikTok"
//
// Merge tags:
//   client.firstName   — "Hi {first_name}"
//   client.companyName — for the body copy context
//   reconnectUrl       — Zernio hosted JWT link, single-use, ~5 min TTL
//   accountManager     — optional { name, email, photo }

import { h } from "../_h.js";
import {
  Body, Button, Container, Head, Heading,
  Html, Preview, Section, Text,
} from "@react-email/components";

const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export default function SocialReconnect(props) {
  const firstName = props?.client?.firstName || "there";
  const companyName = props?.client?.companyName || "your accounts";
  const reconnectUrl = props?.reconnectUrl || "#";

  return h(
    Html,
    {},
    h(Head, {}),
    h(Preview, {}, `Quick reconnect needed for ${companyName}'s TikTok — takes 30 seconds on your phone.`),
    h(
      Body,
      { style: { backgroundColor: "#EEF0F4", margin: 0, padding: "32px 16px", fontFamily: FONT_BODY } },
      h(
        Container,
        { style: { backgroundColor: "#FFFFFF", borderRadius: 12, maxWidth: 560, margin: "0 auto", padding: "32px 28px" } },
        h(
          Heading,
          { as: "h1", style: { fontSize: 22, fontWeight: 700, color: "#0B0D12", margin: "0 0 12px" } },
          "Quick TikTok reconnect"
        ),
        h(
          Text,
          { style: { fontSize: 15, color: "#3A3F4C", lineHeight: 1.55, margin: "0 0 16px" } },
          `Hi ${firstName} — your TikTok connection just dropped. TikTok requires the account owner (you) to re-authorise our scheduler from time to time, so we can't fix this on your behalf the way we can for your other channels.`
        ),
        h(
          Text,
          { style: { fontSize: 15, color: "#3A3F4C", lineHeight: 1.55, margin: "0 0 16px" } },
          "Tap the button below on your phone, log into TikTok if prompted, approve our app, and you're done. Takes about 30 seconds."
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
                padding: "14px 28px", borderRadius: 8,
                fontSize: 15, fontWeight: 600, textDecoration: "none",
                display: "inline-block",
              },
            },
            "Reconnect TikTok →"
          )
        ),
        h(
          Text,
          { style: { fontSize: 13, color: "#6B7180", lineHeight: 1.5, margin: "16px 0 0" } },
          "Link expires in 5 minutes for security. If it lapses, just reply to this email and we'll send a fresh one."
        ),
        h(
          Text,
          { style: { fontSize: 13, color: "#9AA0AE", lineHeight: 1.5, margin: "24px 0 0", borderTop: "1px solid #EEF0F4", paddingTop: 20 } },
          "The Viewix team · viewix.com.au"
        )
      )
    )
  );
}
