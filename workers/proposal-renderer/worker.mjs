#!/usr/bin/env node
// Enterprise proposal worker — runs on the always-on Mac mini (outbound-only).
// Watches /proposalJobs (written by the dashboard's Proposals tab):
//
//   queued    --claim-->  drafting  --Claude-->  review   (draftBrief + _meta for the founder)
//   approved  --claim-->  generating --render--> ready    (pdfUrl, Firebase Storage tokened URL)
//   any failure -> error (+ errorPhase: draft|render; dashboard Retry routes by phase)
//
// Claims are transactional with a per-attempt claimToken; terminal writes verify
// status+workerId+claimToken so a superseded attempt can never clobber a newer
// state (see docs/plans/proposal-worker-scope-packet.md — Codex F2). Jobs are
// processed strictly one at a time.
//
// Usage:
//   node workers/proposal-renderer/worker.mjs                 # daemon (launchd)
//   node workers/proposal-renderer/worker.mjs --once          # one pass over actionable jobs, then exit
//   node workers/proposal-renderer/worker.mjs --dry --job fixtures/job.json [--transcript file.txt]
//                                                             # Stage A locally: live Claude, no RTDB writes

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

// ─── env: workers/proposal-renderer/.env first, repo .env.local fallback ───
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] != null) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnvFile(join(__dirname, ".env"));
loadEnvFile(join(REPO_ROOT, ".env.local"));

const { getAdmin, adminGet, adminPatch, mutateRecord, getStorageBucket } = await import(join(REPO_ROOT, "api/_fb-admin.js"));
const { validateBrief, toRenderBrief, LOOK_VARIANTS } = await import(join(__dirname, "brief-schema.mjs"));
const { BRIEF_TOOL, buildSystemPrompt, buildUserMessage } = await import(join(__dirname, "prompt.mjs"));

const SKILL_DIR = join(REPO_ROOT, "skills/viewix-enterprise-proposal");
const OUT_DIR = join(__dirname, "out");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const STALE_CLAIM_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const WID = process.env.WORKER_ID || `${hostname()}-${process.pid}`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const argOf = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };

const log = (...a) => console.log(new Date().toISOString(), `[${WID}]`, ...a);

async function slack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }); }
  catch (e) { log("slack ping failed:", e.message); }
}

// ─── transcript matching (Codex F3) ───
const LEGAL_SUFFIX_RE = /\b(pty|ltd|limited|inc|llc|co)\b\.?/g;
export function normCompany(s) {
  return String(s || "").toLowerCase().replace(LEGAL_SUFFIX_RE, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function findTranscripts(allFeedback, companyName) {
  const target = normCompany(companyName);
  if (!target) return [];
  return Object.entries(allFeedback || {})
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => {
      const n = normCompany(r.clientName);
      if (!n || !r.transcript) return false;
      if (n === target) return true;
      // Containment only counts when the contained name is distinctive enough —
      // a broad single short token ("sydney") must not auto-match "Sydney Zoo" (Codex 4-B).
      const distinctive = (s) => s.length >= 8 || s.split(" ").length >= 2;
      return (distinctive(n) && target.includes(n)) || (distinctive(target) && n.includes(target));
    })
    .sort((a, b) => {
      const pref = (r) => (["blueprint", "discovery"].includes(r.meetingType) ? 0 : 1);
      if (pref(a) !== pref(b)) return pref(a) - pref(b);
      return String(b.createdAt || b.at || "").localeCompare(String(a.createdAt || a.at || ""));
    });
}
const transcriptMeta = (r) => ({ id: r.id, clientName: r.clientName || "", meetingType: r.meetingType || "", createdAt: r.createdAt || r.at || "", recordingUrl: r.recordingUrl || "" });

// ─── Attio identity (any stage — Codex F10) ───
async function attioIdentity(dealId) {
  if (!dealId) return null;
  try {
    const cache = await adminGet("/attioCache");
    const deal = (cache?.data || []).find((d) => (d?.id?.record_id || d?.id) === dealId);
    if (!deal) return null;
    const { extractVal, extractDealName } = await import(join(REPO_ROOT, "shared/attio-extract.js"));
    return { dealName: extractDealName(deal) || "", dealValueSignal: extractVal(deal) || 0 };
  } catch (e) { log("attio identity lookup failed (continuing without):", e.message); return null; }
}

// ─── Claude (forced tool use — Codex F4) ───
async function draftWithClaude({ job, transcript, attio, references, proofClaims }) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: buildSystemPrompt({ references, proofClaims }), cache_control: { type: "ephemeral" } }],
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: "emit_brief" },
    messages: [{ role: "user", content: buildUserMessage({ job, transcript, attio }) }],
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const toolBlock = data.content?.find((b) => b.type === "tool_use" && b.name === "emit_brief");
    const brief = toolBlock?.input;
    const check = brief ? validateBrief(brief, { requirePrices: false }) : { ok: false, errors: ["no tool_use block in response"], flags: [] };
    if (check.ok) return { brief, flags: check.flags };
    if (attempt === 2 || !toolBlock) throw new Error(`brief failed schema validation: ${check.errors.slice(0, 6).join("; ")}`);
    // Retry: a tool_use turn MUST be answered with a tool_result block — plain
    // text 400s with "tool_use ids were found without tool_result blocks".
    body.messages.push(
      { role: "assistant", content: data.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolBlock.id, is_error: true, content: `Validation failed:\n${check.errors.join("\n")}\nCall emit_brief again with every issue fixed.` }] }
    );
  }
}

// ─── claims + token-checked terminal writes (Codex F2) ───
async function claim(jobId, fromStatus, toStatus) {
  const token = crypto.randomUUID();
  const { committed, snapshot } = await mutateRecord(`/proposalJobs/${jobId}`, (cur) => {
    if (cur.status !== fromStatus) return null;
    return { ...cur, status: toStatus, workerId: WID, claimToken: token, claimedAt: Date.now(), heartbeat: Date.now() };
  });
  return committed && snapshot ? { job: snapshot, token } : null;
}
async function finish(jobId, token, expectStatus, patch) {
  const { committed, snapshot } = await mutateRecord(`/proposalJobs/${jobId}`, (cur) => {
    if (cur.status !== expectStatus || cur.workerId !== WID || cur.claimToken !== token) return null;
    const next = { ...cur, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    return next;
  });
  // committed alone isn't success: mutateRecord's cold-cache path commits a
  // null snapshot unchanged (to force a server refetch) — only a snapshot in
  // the patched status proves the terminal write landed (Codex 1-A).
  const ok = committed && snapshot && snapshot.status === patch.status;
  if (!ok) log(`job ${jobId}: terminal write did not land (superseded or cold-cache) — dropping result; sweep will recover if needed`);
  return ok;
}
function startHeartbeat(jobId) {
  const t = setInterval(() => adminPatch(`/proposalJobs/${jobId}`, { heartbeat: Date.now() }).catch(() => {}), 60_000);
  return () => clearInterval(t);
}

// ─── Stage A: queued -> drafting -> review ───
async function stageDraft(jobId) {
  const claimed = await claim(jobId, "queued", "drafting");
  if (!claimed) return;
  const { job, token } = claimed;
  const stopHb = startHeartbeat(jobId);
  log(`job ${jobId}: drafting for ${job.companyName}`);
  try {
    const [allFeedback, attio] = await Promise.all([adminGet("/meetingFeedback"), attioIdentity(job.dealId)]);
    let matches = findTranscripts(allFeedback, job.companyName);
    if (job.selectedTranscriptId) {
      const picked = Object.entries(allFeedback || {}).find(([id]) => id === job.selectedTranscriptId);
      if (!picked || !picked[1]?.transcript) {
        // A founder explicitly chose this transcript — never silently draft without it (Codex 4-A).
        throw new Error(`selected transcript ${job.selectedTranscriptId} no longer exists — re-queue and pick again`);
      }
      matches = [{ id: picked[0], ...picked[1] }];
    }
    if (matches.length > 1) {
      // Ambiguous — no draft; founder picks a candidate in the review panel (re-queues with selectedTranscriptId).
      await finish(jobId, token, "drafting", {
        status: "review", draftBrief: null, workerId: null, claimToken: null, claimedAt: null, heartbeat: null,
        briefMeta: { transcript: null, candidates: matches.slice(0, 6).map(transcriptMeta), missingFields: [], flags: [], draftedAt: new Date().toISOString(), model: CLAUDE_MODEL },
      });
      return;
    }
    const chosen = matches[0] || null;
    const references = JSON.parse(readFileSync(join(SKILL_DIR, "data/portfolio-references.json"), "utf8")).references;
    const proofClaims = JSON.parse(readFileSync(join(SKILL_DIR, "data/proof-claims.json"), "utf8")).claims;
    const { brief, flags } = await draftWithClaude({ job, transcript: chosen?.transcript || null, attio, references, proofClaims });
    // Sanitize the job's look (manually crafted jobs could carry junk — Codex 5-A);
    // Claude's echo is schema-enum-valid, so it's the safe fallback.
    brief.lookVariant = LOOK_VARIANTS.includes(job.lookVariant) ? job.lookVariant : (brief.lookVariant || "wall");
    const meta = brief._meta || {};
    delete brief._meta;
    await finish(jobId, token, "drafting", {
      status: "review", draftBrief: brief, workerId: null, claimToken: null, claimedAt: null, heartbeat: null,
      briefMeta: {
        transcript: chosen ? transcriptMeta(chosen) : null, candidates: null,
        provenance: meta.provenance || [], missingFields: meta.missingFields || [], flags,
        draftedAt: new Date().toISOString(), model: CLAUDE_MODEL,
      },
    });
    log(`job ${jobId}: draft ready for review`);
  } catch (e) {
    log(`job ${jobId}: draft failed —`, e.message);
    await finish(jobId, token, "drafting", { status: "error", error: String(e.message).slice(0, 500), errorPhase: "draft", workerId: null, claimToken: null, claimedAt: null, heartbeat: null });
    await slack(`:warning: Proposal draft failed for *${job.companyName}* — ${String(e.message).slice(0, 200)}`);
  } finally { stopHb(); }
}

// ─── Stage B: approved -> generating -> ready ───
async function stageRender(jobId) {
  const claimed = await claim(jobId, "approved", "generating");
  if (!claimed) return;
  const { job, token } = claimed;
  const stopHb = startHeartbeat(jobId);
  log(`job ${jobId}: rendering for ${job.companyName}`);
  const briefPath = join(OUT_DIR, `${jobId}.brief.json`);
  const pdfPath = join(OUT_DIR, `${jobId}.pdf`);
  try {
    const check = validateBrief(job.draftBrief, { requirePrices: true });
    if (!check.ok) throw new Error(`approved brief failed validation: ${check.errors.slice(0, 6).join("; ")}`);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(briefPath, JSON.stringify(toRenderBrief(job.draftBrief)));
    execFileSync(process.execPath, [join(SKILL_DIR, "generate.mjs"), "--brief", briefPath, "--out", pdfPath], { stdio: "pipe", timeout: 180_000 });
    const bucket = getStorageBucket();
    if (!bucket) throw new Error("Firebase Storage bucket unavailable");
    const dlToken = crypto.randomUUID();
    const safeName = String(job.companyName || "Client").replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "Client";
    const storagePath = `proposals/${jobId}/${safeName}-Viewix-Proposal.pdf`;
    await bucket.upload(pdfPath, { destination: storagePath, metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: dlToken } } });
    const pdfUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${dlToken}`;
    const ok = await finish(jobId, token, "generating", { status: "ready", pdfUrl, storagePath, readyAt: new Date().toISOString(), workerId: null, claimToken: null, claimedAt: null, heartbeat: null });
    if (ok) await slack(`:white_check_mark: Proposal ready for *${job.companyName}* — download it from the Proposals tab.`);
    log(`job ${jobId}: ready (${storagePath})`);
  } catch (e) {
    const detail = e.stderr ? `${e.message}: ${String(e.stderr).slice(0, 300)}` : e.message;
    log(`job ${jobId}: render failed —`, detail);
    await finish(jobId, token, "generating", { status: "error", error: String(detail).slice(0, 500), errorPhase: "render", workerId: null, claimToken: null, claimedAt: null, heartbeat: null });
    await slack(`:warning: Proposal render failed for *${job.companyName}* — ${String(detail).slice(0, 200)}`);
  } finally {
    stopHb();
    try { rmSync(briefPath, { force: true }); } catch {}
  }
}

// ─── recovery sweep: stale claims (worker died mid-job) revert to their pre-claim status ───
async function sweep() {
  const jobs = (await adminGet("/proposalJobs")) || {};
  for (const [id, j] of Object.entries(jobs)) {
    const stale = (j.status === "drafting" || j.status === "generating") && Date.now() - (j.heartbeat || j.claimedAt || 0) > STALE_CLAIM_MS;
    if (!stale) continue;
    const revertTo = j.status === "drafting" ? "queued" : "approved";
    const staleToken = j.claimToken;
    const { committed, snapshot } = await mutateRecord(`/proposalJobs/${id}`, (cur) => {
      const stillStale = (cur.status === "drafting" || cur.status === "generating") && cur.claimToken === staleToken && Date.now() - (cur.heartbeat || cur.claimedAt || 0) > STALE_CLAIM_MS;
      if (!stillStale) return null;
      const next = { ...cur, status: revertTo };
      delete next.workerId; delete next.claimToken; delete next.claimedAt; delete next.heartbeat;
      return next;
    });
    if (committed && snapshot && snapshot.status === revertTo) log(`job ${id}: recovered stale ${j.status} claim -> ${revertTo}`);
  }
}

// ─── serialized dispatch ───
let chain = Promise.resolve();
const enqueue = (jobId, status) => {
  chain = chain.then(() => (status === "queued" ? stageDraft(jobId) : status === "approved" ? stageRender(jobId) : null))
    .catch((e) => log(`job ${jobId}: unhandled —`, e.message));
};

async function main() {
  if (flag("dry")) {
    // Local Stage-A dry run: fixture job + optional transcript file, live Claude, no RTDB writes.
    const job = JSON.parse(readFileSync(resolve(argOf("job") || join(__dirname, "fixtures/job.json")), "utf8"));
    const transcript = argOf("transcript") ? readFileSync(resolve(argOf("transcript")), "utf8") : null;
    const references = JSON.parse(readFileSync(join(SKILL_DIR, "data/portfolio-references.json"), "utf8")).references;
    const proofClaims = JSON.parse(readFileSync(join(SKILL_DIR, "data/proof-claims.json"), "utf8")).claims;
    const { brief, flags } = await draftWithClaude({ job, transcript, attio: null, references, proofClaims });
    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "dry-draft.json");
    writeFileSync(outPath, JSON.stringify(brief, null, 2));
    console.log(`DRY OK — draft written to ${outPath}${flags.length ? `\nflags:\n  - ${flags.join("\n  - ")}` : ""}`);
    return;
  }

  const { err } = getAdmin();
  if (err) { console.error(err); process.exit(1); }
  await sweep();

  if (flag("once")) {
    const jobs = (await adminGet("/proposalJobs")) || {};
    for (const [id, j] of Object.entries(jobs)) if (j.status === "queued" || j.status === "approved") enqueue(id, j.status);
    await chain;
    log("once: done");
    process.exit(0);
  }

  const { db } = getAdmin();
  const ref = db.ref("/proposalJobs");
  const onJob = (snap) => {
    const j = snap.val();
    if (j && (j.status === "queued" || j.status === "approved")) enqueue(snap.key, j.status);
  };
  ref.on("child_added", onJob);
  ref.on("child_changed", onJob);
  setInterval(() => { sweep().catch((e) => log("sweep failed:", e.message)); }, SWEEP_INTERVAL_MS);
  log(`watching /proposalJobs (model ${CLAUDE_MODEL})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
