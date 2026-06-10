// Pins the smart-window decision for Zernio pulls: full 366d on first
// pull + weekly refresh; cheap 30d window on every other daily run;
// force:"full" overrides.
//
//   node api/_zernioPull.test.mjs

import { decidePullWindow } from "./_zernioPull.js";

let failures = 0;
const ck = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const NOW = Date.parse("2026-06-05T00:00:00Z");
const DAY = 24 * 3600 * 1000;
const daysAgoStr = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);

console.log("First pull (no meta)");
{
  const w = decidePullWindow({ meta: null, now: NOW });
  ck("mode full", w.mode === "full");
  ck("window is 365d", w.fromDate === daysAgoStr(365), w.fromDate);
}

console.log("Recent full pull → cheap daily window");
{
  const w = decidePullWindow({ meta: { lastFullPullAt: NOW - 2 * DAY, lastPullAt: NOW - 1 * DAY }, now: NOW });
  ck("mode recent", w.mode === "recent");
  ck("window is 30d", w.fromDate === daysAgoStr(30), w.fromDate);
}

console.log("Stale full pull (8d ago) → weekly full refresh");
{
  const w = decidePullWindow({ meta: { lastFullPullAt: NOW - 8 * DAY, lastPullAt: NOW - 1 * DAY }, now: NOW });
  ck("mode full again", w.mode === "full");
}

console.log("Exactly at the 7d boundary → still recent (refresh is >7d)");
{
  const w = decidePullWindow({ meta: { lastFullPullAt: NOW - 7 * DAY }, now: NOW });
  ck("mode recent at exactly 7d", w.mode === "recent");
}

console.log("force:'full' overrides fresh meta");
{
  const w = decidePullWindow({ meta: { lastFullPullAt: NOW - 1 * DAY }, now: NOW, force: "full" });
  ck("mode full under force", w.mode === "full");
  ck("window is 365d", w.fromDate === daysAgoStr(365));
}

console.log("Meta missing lastFullPullAt (only lastPullAt) → full");
{
  const w = decidePullWindow({ meta: { lastPullAt: NOW - 1 * DAY }, now: NOW });
  ck("mode full when never fully pulled", w.mode === "full");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
