# Proposal worker (Mac mini)

Watches `/proposalJobs` (written by the dashboard's Proposals tab), drafts the proposal brief with
Claude, waits for founder review/price-confirmation in the dashboard, renders the PDF via
`skills/viewix-enterprise-proposal/generate.mjs`, uploads it to Firebase Storage, and flips the job
to `ready`. Full design: `docs/plans/proposal-worker-scope-packet.md`.

Status chain: `queued → drafting → review → approved → generating → ready | error`
(error carries `errorPhase: draft|render`; the dashboard's Retry routes draft errors back to
`queued` and render errors back to `approved` so confirmed prices are never lost).

## Mac mini setup (one-time, ~20 min)

1. **Install:** Node 18+ (`brew install node`), Google Chrome, and clone this repo.
2. **`npm install`** in the repo root (the worker uses the repo's `firebase-admin`).
3. **Secrets:** create `workers/proposal-renderer/.env` with:
   ```
   # the full service-account JSON on ONE line (no inline comments after values —
   # the env loader takes everything after '=' literally)
   FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
   ANTHROPIC_API_KEY=sk-ant-...
   # optional: ready/error Slack pings
   SLACK_WEBHOOK_URL=https://hooks.slack.com/...
   # optional overrides
   CLAUDE_MODEL=claude-sonnet-4-6
   CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   ```
   (`.env` is gitignored. The repo-root `.env.local` is used as a fallback if present.)
4. **Keep the mini awake:** `sudo pmset -a sleep 0 displaysleep 10` and enable auto-login for the
   worker user (LaunchAgent needs a logged-in session for Chrome).
5. **Smoke test (no RTDB writes):**
   ```bash
   node workers/proposal-renderer/worker.mjs --dry --job workers/proposal-renderer/fixtures/job.json
   ```
   Expect `DRY OK` and a draft at `workers/proposal-renderer/out/dry-draft.json`.
6. **One supervised pass against prod** (requires Jeremy's go): `node workers/proposal-renderer/worker.mjs --once`
7. **Install the LaunchAgent:** edit the absolute paths in `com.viewix.proposal-renderer.plist`
   (node binary: `which node`; repo path), then:
   ```bash
   cp workers/proposal-renderer/com.viewix.proposal-renderer.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.viewix.proposal-renderer.plist
   tail -f /tmp/viewix-proposal-worker.out.log
   ```

## Operations
- **Logs:** `/tmp/viewix-proposal-worker.{out,err}.log`. macOS clears /tmp on reboot; for longer
  retention point the plist paths at `~/Library/Logs/` and rotate with `newsyslog` if needed.
- **Restart:** `launchctl unload` + `load` the plist (KeepAlive restarts it on crash automatically).
- **Stuck jobs:** claims carry a heartbeat; a job stuck in `drafting`/`generating` for >10 min is
  auto-reverted to its pre-claim status by the sweep (on boot + every 5 min).
- **Security model:** the mini makes outbound connections only (Firebase, Attio, Anthropic, Slack).
  RTDB rules give staff create/review/approve/retry transitions only; everything else is the worker
  via the admin SDK.
