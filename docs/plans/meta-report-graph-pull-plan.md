# Plan — Meta Ads Report: Graph API pull (`pull-meta.mjs`)

Scope Packet: `meta-report-graph-pull-scope-packet.md`. Goal: an MCP-free pull that emits the exact
`data/boost-tutoring.json` contract `generate.mjs` already consumes, so the Mac mini cron runs
unattended. No npm deps (Node 18+ `fetch`). Additive: one new file + a `run.sh` rewrite.

## New file: `skills/viewix-meta-ads-report/pull-meta.mjs`

### Inputs
- Env `META_ACCESS_TOKEN` (required) — long-lived token with `ads_read` on both accounts.
- Env `GRAPH_VERSION` (optional, default `v23.0`) — verify it resolves; documented as bump-able.
- `--out <path>` (default `data/boost-tutoring.json`).
- `--from-fixture <path>` (optional) — bypass the network, feed a recorded insights payload through
  the same transform. This is how "Done = renders without error" is proved offline (no token needed).

### Accounts (hardcoded, matches SKILL.md)
- Castle Hill `4506267433028603`
- Beaumont Hills `1701110510860042`

### Per account
1. **Campaign insights** — `GET /{ver}/act_{id}/insights?level=campaign&date_preset=maximum&use_unified_attribution_setting=true&limit=500&fields=campaign_id,campaign_name,spend,impressions,clicks,reach,actions`.
   Follow `paging.next` until exhausted (shared `paginate()` helper). `use_unified_attribution_setting=true`
   makes Graph match Ads Manager / the MCP's attribution **[#2]**.
2. **Normalise each campaign row** (recompute metrics for internal consistency, matching SKILL.md):
   - `spend` = parseFloat → `formatAUD` → `"A$10,834.83"`.
   - `impressions`, `clicks` = ints → `formatInt` → `"652,137"`.
   - `leads` = **`actions[]` entry with `action_type === "lead"`** (Meta's unified cross-channel lead
     metric — the same one the MCP `lead` field is derived from; it already rolls up pixel "Website
     leads" + leadgen "Leads (form)"). Fall back to `omni_lead` ONLY if `lead` is absent. **Never a
     substring sum** — aggregate + component types co-occur and would double-count. `0` if no match.
     **[#1 — resolved; live-token calibration required before trusting prod, see Verification]**
   - `ctr` = clicks/impressions×100 → `"1.39%"` (0 if no impressions).
   - `cpc` = spend/clicks → `"A$1.19"` ("—" if 0 clicks).
   - `cpm` = spend/impressions×1000 → `"A$16.62"`.
   - `cost_per_lead` = leads>0 ? spend/leads → `"A$55.28"` : `"—"`.
3. **Viewix highlight** — find the campaign whose name === `"Viewix Campaign (Leads)"`
   (case-insensitive, trimmed). Build the `viewix` block from it (incl. impressions/cpc) + a short
   static `note`. **If absent in either account → hard fail: `exit 1`, write nothing, post nothing**
   — an empty highlight on an unattended cron is worse than a loud failure. **[#4]**
4. **`campaigns`** = all rows sorted by raw spend desc.
5. **`totals`** = sum raw spend/impressions/clicks/leads across the account's campaigns, then derive
   ctr/cpc/cpm/cost_per_lead with the same helpers. **Reach is NOT summed** (audience overlap).
   Each account object also carries **`account_id`** (the template renders it on the account card). **[#7]**
6. **Creative** — for the Viewix campaign only:
   `GET /{ver}/{viewixCampaignId}/ads?fields=name,effective_status,insights.date_preset(maximum){spend,impressions,clicks,actions}&limit=200`,
   **paginated via the same `paginate()` helper** so a >200-ad campaign can't hide the top spender **[#6]**.
   (Single call gives status + insights together — insights endpoint alone has no `effective_status`.)
   **Parse insights defensively: `ad.insights?.data?.[0]` may be absent** for zero-delivery/paused ads
   → that ad becomes spend `A$0.00`, impressions `0`, clicks `0`, ctr `0.00%`, cpc `—`, leads `0`
   (never `NaN`/crash) **[#5]**. Map to rows {name, status (UPPERCASE, drives the pill), spend,
   impressions, clicks, ctr, cpc, leads, **cost_per_lead** (`"—"` for 0 leads — emitted to keep the
   contract byte-identical even though the table has no CPL column) **[#8]**}, sort by raw spend desc,
   take top 5. Documented gotcha stands: ad-level `maximum` is a recent window and leads are usually
   absent here.

### Top-level object
`client`, `report_title`, `currency: "AUD"`, plus DST-correct stamps derived via
`Intl.DateTimeFormat`/`Intl … timeZone: "Australia/Sydney"`:
- `generated_at` (ISO with the correct Sydney offset — +10:00 AEST / +11:00 AEDT),
- `generated_label` `"Generated Monday 29 June 2026, 8:00 AM AEST"` (label uses the live abbrev),
- `period_label` `"Lifetime to date — through 29 June 2026"`,
- `summary` (combined totals + `accounts` count + total `campaigns` count),
- `accounts: [...]`.

### Formatting helpers
`formatAUD(n)` = `"A$" + n.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})`;
`formatInt(n)` = `n.toLocaleString('en-AU')`; `pct(n)` = `n.toFixed(2)+"%"`. Guard divide-by-zero.

### Errors / safety
- Missing `META_ACCESS_TOKEN` (and not `--from-fixture`) → `exit 1`, clear message.
- Non-2xx or `json.error` from Graph → `exit 1`, print `error.message` only — **never** echo the token
  or full URL (token rides in the `access_token` param; log a redacted URL).
- Build the entire object in memory; **write atomically — `writeFileSync` to `<out>.tmp` in the same
  dir, then `renameSync` over `<out>`** so a killed process can never truncate the file `generate.mjs`
  depends on; the previous good JSON survives until the new full one exists **[#3]**. Reuse
  generate.mjs's existing preflight as the contract check.

## `run.sh` rewrite
Replace the `claude -p` block with the deterministic chain:
```bash
ENVF="$HOME/.config/viewix-meta-report.env"   # tokens, uncommitted, must be chmod 600
[ -f "$ENVF" ] || { echo "missing $ENVF"; exit 1; }                                  # hard fail, not silent skip [#9]
[ "$(stat -f '%Lp' "$ENVF")" = "600" ] || { echo "$ENVF must be chmod 600"; exit 1; } # reject loose perms [#9]
source "$ENVF"
node pull-meta.mjs --out data/boost-tutoring.json
node generate.mjs  --data data/boost-tutoring.json --out out/Boost-Tutoring-Meta-Report.pdf
SUMMARY=$(node -e 'const d=require("./data/boost-tutoring.json");console.log(`Boost Tutoring — Meta ads (${d.period_label}) — Spend ${d.summary.spend} · ${d.summary.leads} leads · ${d.summary.cost_per_lead}/lead · ${d.summary.ctr} CTR.`)')
node post-slack.mjs --pdf out/Boost-Tutoring-Meta-Report.pdf --summary "$SUMMARY"
```
Keep `set -euo pipefail` so any step's failure aborts the run (no stale PDF posted). Document the
`claude -p`/MCP route in README as the interactive alternative (not deleted, just not the cron path).

## Docs
- README: add the Graph API path — token scopes, how to mint a long-lived token, the
  `~/.config/viewix-meta-report.env` file (META_ACCESS_TOKEN, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID),
  and the `GRAPH_VERSION` bump note. Remove the "pull-meta.mjs not built yet" caveat.
- SKILL.md: one line noting the cron uses `pull-meta.mjs` (Graph API), the MCP pull is interactive.

## Verification (Done = renders without error)
1. Build a small `test/sample-insights.json` fixture in the real Graph shape — **include both an
   aggregate `lead` and component lead types (`onsite_conversion.lead_grouped`,
   `offsite_conversion.fb_pixel_lead`) in one `actions[]` array, plus a zero-delivery ad with no
   `insights` edge** — so the fixture actually exercises the #1 double-count guard and the #5
   defensive parse, not just a happy path.
2. `node pull-meta.mjs --from-fixture test/sample-insights.json --out /tmp/probe.json` →
   `node generate.mjs --data /tmp/probe.json` renders with the preflight passing. Assert the fixture's
   lead count equals the single `lead` value, NOT the sum.
3. **Go-live gate (input-bound, needs a real token — documented, not part of this build):** once a
   `META_ACCESS_TOKEN` exists, run `pull-meta.mjs` live against one account and confirm the per-campaign
   `leads` match the MCP `lead` field / Ads Manager. This is the only way to validate #1/#2 attribution;
   it cannot be done offline. If they diverge, switch the lead rule to an explicit disjoint allow-list.

## Out of scope (restating)
Template/render changes, multi-client config, deploying the launchd job, the interactive MCP path.
