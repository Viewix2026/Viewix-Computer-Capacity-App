// Worker entrypoint. PM2 runs this and restarts on crash.
//
// Run-loop: watch /socialAssets for child_added / child_changed events
// matching `status === "queued"` and process them one at a time. We
// don't parallelise within a single worker — Frame.io download
// bandwidth + Zernio upload bandwidth are the bottlenecks, and serial
// processing keeps the Mac Mini's network sane. If throughput ever
// matters, run multiple PM2 instances; the atomic claim handles
// contention.
//
// Heartbeat: every 5 minutes we write /socialAssets/_workerHeartbeat
// with { workerId, ts } so a producer-side dashboard widget (Phase 6
// or later) can flag a stuck worker. Slack alerts on actual transfer
// failures, not on heartbeat absence (that's the dashboard's job).

import { hostname } from "os";
import { initFirebase, db } from "./firebase.js";
import { cleanupOrphanTmpDirs } from "./transfer.js";
import { processRow } from "./worker.js";
import { slack } from "./slack.js";

const HEARTBEAT_MS = 5 * 60 * 1000;
const SCAN_BACKOFF_MS = 15 * 1000; // 15s between full re-scans on idle
const wid = process.env.WORKER_ID || `${hostname()}-${process.pid}`;

let processing = false;
let pending = new Set();

async function tick() {
  if (processing) return;
  if (pending.size === 0) return;
  processing = true;
  try {
    while (pending.size > 0) {
      const next = pending.values().next().value;
      pending.delete(next);
      try {
        await processRow(db(), next);
      } catch (e) {
        console.error(`processRow ${next} unhandled error:`, e);
      }
    }
  } finally {
    processing = false;
  }
}

async function startup() {
  initFirebase();
  console.log(`social-asset-transfer worker ${wid} starting`);
  cleanupOrphanTmpDirs();
  await slack(`:gear: Social asset transfer worker \`${wid}\` started.`);

  // Heartbeat — write every 5 minutes, also at startup.
  const writeHeartbeat = () => {
    db().ref("/socialAssets/_workerHeartbeat").set({
      workerId: wid,
      ts: Date.now(),
    }).catch(e => console.warn("heartbeat write failed:", e.message));
  };
  writeHeartbeat();
  setInterval(writeHeartbeat, HEARTBEAT_MS);

  // Initial scan — pull every queued/failed-with-retry row and pre-fill
  // the pending queue. Subsequent rows arrive via the child_added /
  // child_changed listeners below.
  const snap = await db().ref("/socialAssets").once("value");
  const all = snap.val() || {};
  for (const [key, row] of Object.entries(all)) {
    if (key.startsWith("_")) continue; // heartbeat etc.
    if (row && (row.status === "queued" || (row.status === "claimed" && (Date.now() - (row.claimedAt || 0)) > 30 * 60 * 1000))) {
      pending.add(key);
    }
  }
  console.log(`startup: ${pending.size} pending asset(s) in queue`);

  // Listen for new rows + status changes. We only enqueue when the row
  // is in `queued` state — processRow's claim transaction handles the
  // race if multiple events fire for the same key.
  db().ref("/socialAssets").on("child_added", snap => {
    if (snap.key.startsWith("_")) return;
    const v = snap.val();
    if (v && v.status === "queued") {
      pending.add(snap.key);
      void tick();
    }
  });
  db().ref("/socialAssets").on("child_changed", snap => {
    if (snap.key.startsWith("_")) return;
    const v = snap.val();
    if (v && v.status === "queued") {
      pending.add(snap.key);
      void tick();
    }
  });

  // Idle re-scan — covers webhook + listener gaps. Cheap (one read
  // every 15s) and bounded by the queue size.
  setInterval(() => { void tick(); }, SCAN_BACKOFF_MS);

  // Kick off the first tick.
  void tick();
}

startup().catch(async e => {
  console.error("Worker startup failed:", e);
  await slack(`:rotating_light: Social asset transfer worker startup failed: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown — give in-flight transfers a moment to finish
// before PM2 kill -9s us. PM2's default kill timeout is 1.6s, override
// in ecosystem.config.cjs if transfers run long.
process.on("SIGTERM", async () => {
  console.log("SIGTERM — finishing in-flight before exit");
  await slack(`:wave: Social asset transfer worker \`${wid}\` shutting down (SIGTERM).`);
  // Stop accepting new work.
  pending.clear();
  // Let the current processRow finish.
  const start = Date.now();
  while (processing && (Date.now() - start) < 30000) {
    await new Promise(r => setTimeout(r, 200));
  }
  process.exit(0);
});
