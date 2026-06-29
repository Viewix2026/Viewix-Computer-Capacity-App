# Scope Packet — Meta Ads Report: Graph API pull (unattended cron)

**Feature slug:** `meta-report-graph-pull`
**Created:** 2026-06-29 · via make-a-feature (fast path)

## Outcome
The Monday Meta ads report lands in Slack **fully unattended** on the Mac mini, even if
headless `claude -p` can't see the interactively-authenticated Meta/Slack MCPs. Achieved by a
direct Meta Graph API pull that replaces the MCP step in the cron path.

## Out of scope (this round)
- Report template / layout changes (`template/`, `generate.mjs` render logic) — untouched.
- Multi-client generalisation (stays hardcoded to the two Boost Tutoring accounts).
- The **interactive MCP path** — `SKILL.md`'s MCP pull stays as the on-demand/testing route.
- Actually installing/firing the launchd job on the mini (separate deploy step).

## Done looks like
`node pull-meta.mjs` (given a token) writes `data/boost-tutoring.json` that is **schema-valid and
passes `generate.mjs`'s preflight** (renders without error). Cross-checking the numbers against the
MCP pull is a nice-to-have, not the bar. Logic is provable offline by feeding a recorded Graph
insights payload through the transform.

## Hard constraints
- **Meta token via env only** (`META_ACCESS_TOKEN`), never written to a file or committed. Document
  how to mint/refresh a long-lived token.

## Resolved decisions
- **Scope** = pull script + cron wiring (rewire `run.sh` to chain pull → generate → post-slack,
  zero MCP dependency). Not deploy.
- **Token** = env var, uncommitted.

## Resolved decisions (cont.) — settled at the plan-loop, pending Gate 1 sign-off
- **Lead attribution** = `actions[]` entry with `action_type === "lead"` (Meta's unified metric the
  MCP `lead` field derives from); `omni_lead` fallback only if absent; **never a substring sum**
  (would double-count aggregate + component types — Codex #1). Live-token calibration vs the MCP
  `lead` field is the documented go-live gate (input-bound, can't be done offline).
- **Graph version** = `GRAPH_VERSION` env, default `v23.0`, documented as bump-able; verify it
  resolves on first live run.
- **`run.sh`** = explicit `pull-meta → generate → post-slack` chain is the cron path (deterministic,
  no MCP); the `claude -p`/MCP route stays documented as the interactive alternative.

## Codex plan-loop (round 1, then stopped — input-bound)
Adopted: #1 lead rule (no substring sum), #2 unified attribution, #3 atomic write, #4 missing-Viewix
hard-fail, #5 zero-spend ad defensive parse, #6 ad pagination (free via shared helper), #7 account_id,
#8 emit creative cost_per_lead, #9 env-file perms guard. Documented-only: #10 fixture vs live-smoke.
No architecture forks. Stopped after 1 round: remaining risk (#1/#2) is input-bound on a live token.

## Approved plan
**APPROVED at Gate 1 (2026-06-29) — "build it".** See `meta-report-graph-pull-plan.md` (updated with
all adopted findings). Building pull-meta.mjs + fixture, run.sh rewrite, docs; then the code Codex loop → Gate 2.

## Implementation deltas
No material deviation from the approved plan (Gate 1.5 never tripped). Code-loop (round 2) refinements:
- #2 carry-over: added `use_unified_attribution_setting(true)` to the **ad-level** nested insights too
  (plan had it only on campaign insights) so creative rows match campaign attribution.
- #11: `paginate()` now throws on exceeding the 50-page cap instead of silently truncating.
- #12: per-process temp filename (`<out>.<pid>.<ts>.tmp`) to avoid an overlapping-run rename race.
- Cosmetic: AM/PM uppercased in `generated_label` to match house style.

Verified offline (Done bar met): `pull-meta.mjs --from-fixture` → `generate.mjs` renders; fixture's
mixed lead types yield 4 (not 12); zero-delivery ad yields zeros; DST stamp correct. Live-token
calibration vs the MCP `lead` field remains the documented go-live gate.

## Gate 2 outcome — PARKED (not shipped)
At Gate 2 (2026-06-30) Jeremy questioned the premise. Evidence settled it: the Meta/Slack MCPs are
injected by the Claude Code app/connector layer and are NOT in the CLI's `~/.claude.json` (only
`higgsfield` is), so a headless cron `claude -p` would not have them — confirming the cron needs the
token path. Given that, Jeremy chose **MCP semi-manual** (trigger the report on demand in a Claude
session; zero tokens) over the token-based cron. Decision: **drop `pull-meta.mjs` + the cron**.
Removed: `pull-meta.mjs`, `test/sample-insights.json`, `schedule/run.sh`, the launchd plist. This
plan + plan-doc are kept as the full spec to rebuild from if full automation is ever wanted.
The code was complete and passed both Codex loops — parked by product decision, not by a defect.
