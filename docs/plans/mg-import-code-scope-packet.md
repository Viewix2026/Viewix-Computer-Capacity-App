# Scope Packet — Motion Graphics: import/paste component code → port to a recordable fragment

## Outcome
An editor can paste a UI component or code snippet (React Bits and the like — React/JSX, HTML+CSS, or vanilla JS) into an **Import** modal; Opus ports it to a self-contained, transparent, looping fragment that loads straight into the preview to refine / save / screen-record. Turns "I found a cool component online" into a recordable Viewix asset in one step.

## Out of scope
- Saving the pasted source (only the ported fragment flows through the normal pipeline; source isn't persisted).
- A library/catalogue of importable components, or fetching from a URL (paste only).
- Re-skinning the port to Viewix/Client brand (the port stays FAITHFUL to the pasted look; brand re-skin is a later refine step the user can ask for).
- Multi-file imports / dependency resolution (single pasted blob).

## Done looks like
- An **Import** button opens a modal with a big monospace code box (limit ~50KB) and a Port button.
- Porting calls Opus, returns a guarded fragment that loads into the preview exactly like a generation (refine bar, Save, Present, Source all work).
- The port strips web-embed baggage (framework wiring, JSX/imports, drag/pointer interactivity, 100vh jackets, opaque backgrounds) and keeps the animation, transparent, looping ~loop seconds, sized to the chosen Format.
- Spend is ledgered (type "port") and counts against the daily cap. Codex round; preview green; merged; prod live. No firebase deploy.

## Hard constraints
- The ported fragment is UNTRUSTED model output → same trust boundary as generate: `injectGuard` + sandboxed-iframe CSP. No exceptions.
- Reuse the endpoint auth + helpers (requireRole + per-action /users check; callClaude, injectGuard, writeLedgerSafe, computeCost, runRtdbTransaction daily cap, genId).
- Body stays small (code is text, ≤50KB ≪ Vercel 4.5MB). Validate sourceCode (string, length cap) server-side.
- Do NOT modify the shipped handleGenerate hot path — add a separate `port` action/handler (small cap+ledger duplication is acceptable for isolation).

## Resolved decisions
- **Separate Import button → modal** (Jeremy chose this over a Describe toggle). The ported result loads into the preview as a normal generation (fromLibrary:false, no reviseOf, type:null → saves as "Other").
- **Port via Opus** (claude-opus-4-7), not a deterministic transpiler — the model port is the whole value and handles React/HTML/JS uniformly.
- **Faithful port** — keep the component's own colours/type; just make it self-contained + transparent + looping + sized. Brand control is NOT applied to a port; user can refine toward Viewix after if they want.
- **sourceCode limit 50KB**, respects Format/Loop controls, ledger type "port", daily cap applies.

## Open decisions
None.

## Approved plan
1. Backend `api/motion-graphics.js`: `LIMITS.sourceCode = 50*1024`; `buildPortSystemPrompt(w,h,dur)`; new `port` action → `handlePort` (validate sourceCode + dimension + dur; daily-cap bump; callClaude with the port prompt + source; injectGuard; writeLedgerSafe type "port"; return {id,html,fragment,dimension,cost}). Wire switch + docstring.
2. Frontend `MotionGraphicsGenerator.jsx`: an Import button (left-panel header); an Import modal (monospace textarea, char count, Port button with loading + AbortController/170s); `portCode()` sets the result like a generation; flows through preview/refine/save.
3. Codex adversarial loop → triage → fix → verify.
4. Ship: commit, preview green, PR→main, watch prod.

## Implementation deltas
- **Codex round 1 — both adopted, security path confirmed clean:**
  - #7 (Med) Generate and Port could run concurrently (separate AbortControllers) and race two Opus calls, corrupting `result` + wasting spend. Fix: `portCode` returns early on `porting || generating || abortRef.current`; `callGenerate` returns early on `porting` (added to its useCallback deps); `canGen`/`canRefine` include `!porting`; the Import button is disabled while `generating || porting`.
  - #8 (Low) in-flight port wasn't aborted on unmount. Fix: `portAbortRef` stored + aborted in the existing unmount cleanup alongside `abortRef`.
  - Codex confirmed safe: pasted code only travels to Opus as text and the OUTPUT is injectGuard-wrapped + sandboxed (no unguarded DOM path); cap/ledger mirror generate (cold-cache null → writes 1; rejected port still ledgers, no double-count); client maxLength vs server length consistent; no regression to generate/enhance/save/update/setType/assign/template.
