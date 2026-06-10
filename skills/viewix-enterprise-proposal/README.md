# Viewix Enterprise Proposal Renderer

Fills the keyed HTML proposal template from a `proposal_brief.json` and renders a client-ready,
11-slide 16:9 PDF via headless Chrome. Design + decisions: `docs/plans/enterprise-proposal-generator.md`.

## Requirements
- Node 18+ (no npm dependencies)
- Google Chrome installed (override the binary with `CHROME=/path/to/chrome`)

## Usage
```bash
node generate.mjs --brief data/transgrid.brief.json --out out/Transgrid-proposal.pdf [--look wall|strip|hero|colour|desk] [--keep]
```

The run is gated by a preflight (via Chrome `--dump-dom`): it refuses to render if leftover template
tokens (`ACCIONA`, `Graduate Program`), unconfirmed prices (`$00,000`), or stray `{{placeholders}}`
remain, and warns when copy exceeds the slide length budgets.

## Layout
- `template/proposal-template.html` — the master deck (keyed with `data-field` / `data-repeat`;
  `.fld` markers are stripped in export mode)
- `template/fill.js` — in-browser fill engine (binds the brief, expands repeats, locks the look)
- `template/deck-stage.js` — slide stage + one-page-per-slide print engine (from Claude Design)
- `data/*.brief.json` — example briefs (ACCIONA = the WeMOV benchmark example, Transgrid = client-swap test)
- `out/` — generated PDFs (gitignored)

## Consumers
- Run directly in a Claude Code session, or
- The Mac mini worker (watches `/proposalJobs` from the dashboard's Proposals tab) — see the plan doc.
