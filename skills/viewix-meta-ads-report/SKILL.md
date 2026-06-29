---
name: viewix-meta-ads-report
description: Pull both Boost Tutoring Meta ad accounts via the Meta Ads MCP, write data.json, render the branded multi-page PDF report, and deliver it to the "Meta Ads Management" Slack channel. Use when asked to run/refresh/generate the Meta ads report, the weekly ads report, or the Boost Tutoring ads report. This is the recipe the weekly cron also follows.
---

# Viewix Meta Ads Report

Generates `Boost Tutoring Australia`'s Meta ads performance PDF from live account data and
posts it to Slack. Runs the same way interactively or unattended (Mac mini cron — see README.md).

**Two ad accounts** (both AUD, both MCP-enabled):
- Castle Hill — `4506267433028603`
- Beaumont Hills — `1701110510860042`

The campaign literally named **"Viewix Campaign (Leads)"** in each account is the Viewix-managed
campaign and gets the highlight block. Everything else is the client's own / other campaigns.

## Pipeline (do these in order)

### 1. Pull the data (Meta Ads MCP)
For **each** account, call `ads_get_ad_entities` with `level: "campaign"`, `date_preset: "maximum"`,
and `fields: ["id","name","spend","impressions","clicks","ctr","cpc","cpm","reach","lead","cost_per_result"]`.

Then for the **"Viewix Campaign (Leads)"** in each account, pull its ads:
`level: "ad"`, `fields: [...,"effective_status","lead"]`,
`filtering: [{ "field": "campaign.id", "operator": "EQUAL", "value": ["<viewix campaign id>"] }]`.

Verify any field you're unsure about with `ads_get_field_context` before querying.

**Gotchas (these bit during the build — honour them):**
- Use the **`lead`** field for lead counts and compute **cost-per-lead = spend / leads** yourself.
  Meta's `cost_per_result` is usually identical but occasionally diverges from `lead` (it counts
  "results", which can differ). Recomputing keeps the report internally consistent.
- **Reach is not additive** across campaigns/accounts (audiences overlap). Do NOT sum it for an
  account or combined total. Report reach only at the single-campaign level, or omit it.
- At **`level: "ad"`, `date_preset: "maximum"` silently collapses to a recent window** (every ad
  comes back `date_start` ≈ a few days ago) and most ads return `lead: "Not available"` /
  `cost_per_result: A$0.00`. Treat ad-level as a *recent creative snapshot only*, never as lifetime.
  Render "Not available" leads as `0` and missing cost-per-lead as `"—"`.
- Money comes back as `"A$1,234.56 AUD"`. Keep the `A$` + thousands separators in the JSON strings
  exactly — the template prints them verbatim.

### 2. Write `data/boost-tutoring.json`
Overwrite it to match the schema below. Stamp the run:
- `generated_at`: ISO 8601 with the AEST offset, e.g. `2026-06-29T08:00:00+10:00`.
- `generated_label`: human stamp, e.g. `Generated Monday 29 June 2026, 8:00 AM AEST`.
- `period_label`: e.g. `Lifetime to date — through 29 June 2026`.

Compute combined `summary` (sum spend/impressions/clicks/leads; CTR = clicks/impr,
CPC = spend/clicks, CPM = spend/impr×1000, cost_per_lead = spend/leads). Per account: `totals`
(same maths over that account's campaigns), the `viewix` highlight (the Viewix campaign + a short
honest `note`), the full `campaigns` array (sorted by spend, desc), and a `creative` array (top ~5
ads in the Viewix campaign by spend, with `status` = ACTIVE/PAUSED).

Schema is exactly what `data/boost-tutoring.json` already contains — keep that as the worked example.

### 3. Render the PDF
```bash
node generate.mjs --data data/boost-tutoring.json --out out/Boost-Tutoring-Meta-Report.pdf
```
The script preflights (data shape, fill.js ran to completion, summary actually rendered, no leftover
sample tokens) and refuses to render on failure. Needs only Node 18+ and Google Chrome.

### 4. Deliver to Slack — channel "Meta Ads Management"
Compose a one-line-per-account summary, e.g.:
> *Boost Tutoring — Meta ads (lifetime to 29 Jun)* — Spend A$22,867 · 537 leads · A$42.58/lead · 1.30% CTR.
> Castle Hill A$55.28/lead · Beaumont A$35.29/lead. Full report attached.

The Slack MCP **cannot upload a file**. Pick one delivery path:
- **MCP-native (no setup):** upload the PDF to Google Drive with the Drive MCP `create_file`
  (`base64Content`, `contentMimeType: "application/pdf"`, into the team's reports folder via
  `parentId`), then `slack_send_message` the summary + the Drive link to the channel.
  (Note: changing Drive sharing/permissions is out of scope for the agent — use a folder the team
  can already see, or let Jeremy set sharing.)
- **True in-channel PDF (best for the cron):** `node post-slack.mjs --pdf out/Boost-Tutoring-Meta-Report.pdf --summary "<text>"`
  with `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` set (see README.md).

Confirm the channel id first with `slack_search_channels` ("Meta Ads Management"). Posting to Slack
is an outward-facing action — when running interactively, show the summary and confirm before sending
unless told to just post.

## Notes
- This runs **interactively, on demand** — you say "run the Meta ads report" in a Claude Code session
  that has the Meta + Slack MCPs, and it pulls → renders → delivers. It is NOT a headless cron: a
  cron-launched `claude -p` doesn't inherit these app/connector MCPs (verified — they aren't in the
  CLI's `~/.claude.json`). The full-automation design (a token-based Graph API pull) is preserved in
  `docs/plans/meta-report-graph-pull-plan.md` if it's ever wanted.
- The report is currently **lifetime** figures. To switch to rolling 7-day, change the pull to
  `date_preset: "last_7d"` and update `period_label`; the template doesn't change.
- As the "Viewix Campaign (Leads)" matures, revisit the `note` copy in the highlight block.
