# Scope Packet — Motion Graphics: team-editable templates + feedback

## Outcome
The "Start from a preset" rail stops being hardcoded. Any editor (founders / manager / lead / editor) can edit a built-in preset, add their own team template, reset/remove one, and leave a feedback note on any template — so the preset rail becomes a living, team-curated library instead of a fixed code list.

## Out of scope (this round)
- Template version history / change log (just last-writer-wins + audit stamp).
- Threaded feedback replies, @mentions, resolution state (a flat note list per template; notes can be deleted when addressed).
- Per-client template scoping (templates are shared across the whole team, like the library).
- Drag-to-reorder (order is numeric: built-ins keep their code order, customs append).
- Touching the generate / save / library / brand-pull paths.

## Done looks like
- A "Manage" button on the preset group opens a modal listing all templates.
- Editing a built-in and saving makes the edited version show in the rail immediately (live via RTDB listener) for everyone.
- Adding a new template makes a new pill appear in the rail.
- Reset on an edited built-in reverts it to the code default; Delete on a custom removes it.
- A feedback note added to a template is visible to the team with author + date; it can be deleted.
- All writes go through the server (RTDB rule write:false); a `trial` user can't touch any of it.
- Codex code loop converged; Vercel preview green; merged to main; firebase rules deployed; live on prod.

## Hard constraints
- Reuse the existing endpoint (`api/motion-graphics.js`) auth model: `requireRole(GENERATE_ROLES)` + the fresh `/users/{uid}` active+role check that already runs for every action. No new auth surface.
- Client-supplied template ids become RTDB path segments → must pass a `validTemplateId` regex (mirror the existing `validId` path-injection guard).
- Server-only writes; new RTDB nodes get `read: any-role`, `write:false` (mirror `motionGraphicsLibrary`). Rules deploy is a separate `firebase deploy --only database`.
- No new runtime deps, no cron, no cost surface (these actions don't call Claude).

## Resolved decisions
- **Override model (not migration/seed).** Built-in PRESETS stay in code as the defaults. `/motionGraphicsTemplates/{mgt_*}` stores overrides of built-ins (keyed `mgt_<presetKey>`) and net-new customs (keyed `mgt_<ts>_<rand>`). The UI merges code defaults + overrides by id. *Why:* no seeding race, graceful if the node is empty/unreachable, and "edit a built-in" is a natural override. The UI derives `builtin` from its own PRESETS list, so the **server treats every template uniformly** — no trusted builtin flag.
- **Feedback in a separate node** `/motionGraphicsTemplateFeedback/{templateId}/{fbId}`. *Why:* a built-in with no override doc still needs an attach point; decoupling feedback from the override doc keeps both simple.
- **Delete = hard-null the doc** (one op). Built-in id → reverts to code default ("Reset"); custom id → gone ("Delete"). *Why:* avoids a soft-delete `deleted` flag and its bookkeeping; the UI labels the same op by builtin-ness. Code defaults are the safety net, so reverting a built-in is non-destructive.
- **Edit rights = all GENERATE_ROLES.** *Why:* the user asked for "my team" to update presets; that's the whole editing team. Small trusted team, server-audited (createdBy/updatedBy stamped), so no per-row ownership lock for v1.
- **Validation:** label ≤ 60, prompt ≤ 2000 (reuse LIMITS.prompt), icon ∈ a 12-name whitelist that exists in Icon.jsx, fmt ∈ {Portrait,Landscape,Square}, note ≤ 500, order clamped 0..99999.
- **UI placement:** pills in the 348px left rail stay "click to apply"; all CRUD + feedback lives in a centered Manage modal (room to edit; rail stays clean) — mirrors the existing Source/Present modals.

## Open decisions
None — user said "do whatever you need to do to get it live, don't stop." All forks defaulted above with rationale.

## Approved plan
Autonomous build (user waived gates for this feature). Steps:
1. Backend `api/motion-graphics.js`: add `validTemplateId`, icon/fmt whitelists, `genTemplateId`, and four actions — `templateSave` (create/update), `templateDelete` (hard-null), `templateFeedback` (add note), `templateFeedbackDelete` (remove note). Wire into the action switch + docstring.
2. Frontend `MotionGraphicsGenerator.jsx`: listen to both new nodes; module-level `BUILTIN_TEMPLATES`/id-set; `rail` = merged+sorted list driving the pills; `applyTemplate`; a Manage modal (list → edit form with icon picker + fmt segment + prompt textarea; feedback panel with add/delete; New / Reset / Delete).
3. `firebase-rules.json`: two new nodes after `motionGraphicsLibrary`, read=any-role write=false.
4. Codex adversarial loop on the code → triage → fix → re-verify.
5. Ship: commit on `feat/mg-team-templates`, gate preview green, PR→main, deploy rules, watch prod.

## Implementation deltas
- **Codex round 1 → Finding 1 (High, ADOPTED).** `fbListenSafe` suppresses post-load nulls (Firebase stale-null guard), so deleting the LAST template/feedback doc (node → null) wouldn't clear the UI until refresh. Fix: added an opt-in `opts.allowNull` 4th param to `fbListenSafe` (backward-compatible across all 34 call sites) and enabled it for `/motionGraphicsTemplates` + `/motionGraphicsTemplateFeedback`. Safe because the rail still renders built-ins from code, so a spurious token-refresh null only briefly drops overrides and self-heals. *(touches shared src/firebase.js — re-reviewed in round 2.)*
- **Codex round 1 → Finding 2 (Medium, PUSHED BACK).** "Live-sync the prompt textarea when a template updates/resets." Rejected: the textarea is a decoupled working draft (preset click copies in); live-syncing would clobber in-progress user edits. A deleted custom just drops the cosmetic pill highlight; generation already uses the textarea contents the user sees. The fix would introduce a worse bug than it solves.
- **Codex round 1 → Finding 3 (Low, DEFERRED — Codex agreed).** "Reject feedback to a non-existent template id." The proposed existence check would 404 feedback on un-overridden built-ins (the common case, since built-ins have no doc); doing it right needs the server to hardcode the built-in id set (coupling deliberately avoided). Risk is junk data from a trusted insider. Trigger to revisit: templates exposed to less-trusted roles, or orphan-feedback buildup.
