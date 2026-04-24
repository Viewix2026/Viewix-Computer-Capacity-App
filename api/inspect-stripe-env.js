// One-shot diagnostic — print the SHAPE of Stripe-related env vars
// (length + first/last 4 chars only — never the full secret) so we
// can compare with what Stripe Dashboard shows for the webhook
// destination's signing secret. Delete this file once the
// 400-mismatch mystery is resolved.
//
// Usage: curl https://planner.viewix.com.au/api/inspect-stripe-env

function shape(name) {
  const v = process.env[name];
  if (v === undefined) return { name, set: false };
  if (v === "") return { name, set: true, length: 0, note: "empty string" };
  return {
    name,
    set: true,
    length: v.length,
    firstFour: v.slice(0, 4),
    lastFour: v.slice(-4),
    hasLeadingSpace: v[0] === " " || v[0] === "\n",
    hasTrailingSpace: v[v.length - 1] === " " || v[v.length - 1] === "\n",
  };
}

export default function handler(req, res) {
  res.status(200).json({
    note: "Shape only — never the full secret. Compare firstFour+lastFour against Stripe Dashboard's reveal.",
    vars: [
      shape("STRIPE_SECRET_KEY"),
      shape("STRIPE_WEBHOOK_SECRET"),
      shape("STRIPE_WEBHOOK_SECRET_TEST"),
      shape("STRIPE_WEBHOOK_SECRET_LIVE"),
      shape("VITE_STRIPE_PUBLISHABLE_KEY"),
      shape("SLACK_SALES_WEBHOOK_URL"),
    ],
  });
}
