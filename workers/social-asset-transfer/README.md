# social-asset-transfer

Mac Mini worker that streams approved Frame.io originals into Zernio's
own media store so the dashboard's social posting scheduler can publish
without ever holding a signed URL that might expire.

## What it does

When a video is approved by the client (revision1 or revision2 flips to
"Approved"), the dashboard fires a side-effect POST to
`api/on-video-approved.js` which writes a row at
`/socialAssets/{deliveryId}_{videoId}` with `status: "queued"`.

This worker watches that path. For each queued row it:

1. Atomically claims the row via a Firebase transaction.
2. Calls Frame.io for a fresh 24h CloudFront signed URL.
3. Downloads the original to `/tmp`.
4. Computes a sha256 fingerprint + runs ffprobe for duration/dimensions.
5. Requests a presigned upload URL from Zernio's `/media/presign`.
6. PUTs the bytes to the presigned target.
7. Writes `status: "ready"` + `zernioMediaUrl` + metadata back to
   `/socialAssets/{key}`, and mirrors `zernioMediaUrl` onto
   `/deliveries/{id}/videos/{idx}.zernioMediaUrl`.
8. Cleans up the tmp file.

Once `zernioMediaUrl` is set, the Schedule Posting modal in the
dashboard is unlocked for that delivery — the modal pushes scheduled
posts to Zernio with `mediaUrl: zernioMediaUrl`, and Zernio publishes
at the scheduled time without needing the original Frame.io URL at all.

## Setup on the Mac Mini

Prereqs:
- Node 20.6+ (for `--env-file=` support)
- `ffmpeg` / `ffprobe` (Homebrew: `brew install ffmpeg`)
- PM2 (`npm install -g pm2`)

Install:

```bash
cd workers/social-asset-transfer
npm install
cp .env.example .env
# Fill in FIREBASE_SERVICE_ACCOUNT, FRAMEIO_*, ZERNIO_API_KEY,
# SLACK_VIDEO_DELIVERIES_WEBHOOK_URL
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # follow the printed sudo command so PM2 starts on boot
```

Tail logs:

```bash
pm2 logs social-asset-transfer
```

## Failure modes

- **Frame.io download fails** — bumps `attempts`, returns row to
  `queued`, retries. After 3 attempts, marks `failed` and Slack-pings
  `#video-deliveries`.
- **Zernio presign fails** — same retry path.
- **Upload PUT fails** — same retry path.
- **Source file changed between approval and transfer** (producer
  swapped the linked Frame.io file): worker computes new fingerprint,
  compares to stored `sourceFingerprint`. Mismatch → marks `stale`,
  clears `zernioMediaUrl`, Slack-pings. Producer hits "Re-queue
  transfer" in the Deliveries UI to retry with the new file.
- **Worker crashes mid-transfer** — the next worker (or the same one
  after PM2 restart) re-claims rows in `claimed` state older than 30
  min. `attempts` is incremented to prevent poison-row loops.

## Heartbeat

Every 5 minutes the worker writes `/socialAssets/_workerHeartbeat`
with `{ workerId, ts }`. The producer-side Social Connections admin
view (or a future ops dashboard) can flag a stuck worker by polling
this path.

## Re-queueing failed transfers

From the dashboard: Deliveries → click into a delivery → if any video
shows "Transfer failed" or "Asset stale", hit "Re-queue transfer".
That calls `api/social-asset-requeue.js` which resets
`/socialAssets/{key}.status = "queued"` and zeroes `attempts`, and the
worker picks it up on its next scan.

## Verification before going live

Per the plan file's Verification section, before any client roster
roll-out, this end-to-end path must be proven:

```
Approved Frame.io asset
  → Mac Mini worker pulls fresh signed URL
  → streams to Zernio presigned upload
  → Zernio returns publicUrl
  → Vercel calls Zernio createPost with that publicUrl, postAt 5 days out
  → Zernio publishes successfully at the scheduled time
```

This is the spine of the whole product. If it breaks, every later
phase is wasted.
