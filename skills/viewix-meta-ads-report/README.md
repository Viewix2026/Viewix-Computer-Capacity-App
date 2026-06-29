# Viewix Meta Ads Report

Branded, multi-page PDF of `Boost Tutoring Australia`'s Meta ads performance across both locations —
pulled live from the Meta Ads MCP, rendered with headless Chrome, delivered to the
`Meta Ads Management` Slack channel. Run **on demand** from a Claude Code session that has the
connectors; you trigger it, it does the rest.

The agent recipe is `SKILL.md`. This file is the operator/setup reference.

## Layout
- `SKILL.md` — the step-by-step recipe a Claude Code agent (interactive, via the MCPs) follows.
- `template/report.html` — keyed template (`data-field` / `data-repeat`), brand-styled, paginated A4.
- `template/fill.js` — in-browser binder; reads `window.__DATA__`, clones rows via `cloneNode`.
- `generate.mjs` — fills the template from a data JSON and renders the PDF via Google Chrome. No npm deps.
- `post-slack.mjs` — optional: uploads the PDF into Slack as a real attachment (token path; see below).
- `data/boost-tutoring.json` — the live data + the canonical schema/worked example.
- `out/` — generated PDFs (gitignored).

## Requirements
- Node 18+ and Google Chrome (override binary with `CHROME=/path/to/chrome`).
- Meta Ads MCP + Slack (or Google Drive) MCP connected in the Claude Code session you run it from.

## Run it
In a Claude Code session with the connectors:
> "Run the Meta ads report."

The agent follows `SKILL.md`: pulls both Boost Tutoring accounts via the Meta Ads MCP, writes
`data/boost-tutoring.json`, renders the PDF, and delivers it. To just re-render from existing data:
```bash
node generate.mjs --data data/boost-tutoring.json --out out/Boost-Tutoring-Meta-Report.pdf
```

## Delivery to Slack (the connector can't attach files)
The Slack MCP sends messages but **cannot upload a file**. Two paths:

1. **MCP-native, zero setup** — upload the PDF to Google Drive (`create_file`, base64,
   `application/pdf`) and `slack_send_message` the summary + Drive link to the channel. Use a Drive
   folder the team can already see (the agent does not change sharing).
2. **True in-channel PDF** — `post-slack.mjs` (needs a Slack bot token):
   ```bash
   export SLACK_BOT_TOKEN=xoxb-...        # scopes: files:write, chat:write
   export SLACK_CHANNEL_ID=C0XXXXXXX      # the "Meta Ads Management" channel id
   node post-slack.mjs --pdf out/Boost-Tutoring-Meta-Report.pdf --summary "…"
   ```

## Changing the report
- **Lifetime → rolling 7 days:** in the MCP pull, use `date_preset: "last_7d"` and update `period_label`.
  Template unchanged.
- **Schema:** mirror `data/boost-tutoring.json`. `generate.mjs` preflights shape, that the fill ran
  (`body.ready`), that a summary value actually rendered, and that no sample tokens leaked.

## If you ever want it fully unattended
This runs interactively because a headless cron's `claude -p` doesn't inherit the app/connector MCPs
(verified — they're not in the CLI's `~/.claude.json`). The full-automation design — a token-based
Meta Graph API pull (`pull-meta.mjs`) + launchd cron — was built and Codex-reviewed, then parked when
on-demand was chosen. The complete spec is in `docs/plans/meta-report-graph-pull-plan.md`; rebuild
from there if the weekly trigger ever becomes a chore.
