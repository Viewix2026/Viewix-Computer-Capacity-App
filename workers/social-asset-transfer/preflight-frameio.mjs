// Preflight check for the worker's Frame.io auth + media endpoint.
// Run this from your laptop (or the Mac Mini) BEFORE starting the
// worker, to prove the configured token actually pulls media.
//
// Usage (loads .env via Node's --env-file, needs Node 20.6+):
//
//   # 1. Auth-only — lists accounts, prints the account id:
//   node --env-file=.env preflight-frameio.mjs
//
//   # 2. Full media-path test against one real file:
//   node --env-file=.env preflight-frameio.mjs <frameioFileId>
//   #    (or set FRAMEIO_TEST_FILE_ID in .env and omit the arg)
//
// Exits 0 on PASS, 1 on FAIL. Never prints the token or a full signed
// URL — only the download host, so output is safe to paste.

import { getAccounts, getOriginalMediaUrl } from "./frameio.js";

function hostOf(u) {
  try { return new URL(u).host; } catch { return "(unparseable)"; }
}

async function main() {
  const fileId = process.argv[2] || process.env.FRAMEIO_TEST_FILE_ID || null;
  const mode = process.env.FRAMEIO_AUTH_MODE || "legacy";
  console.log(`Frame.io preflight — auth mode: ${mode}`);

  // 1. Auth check via GET /v4/accounts.
  let accounts;
  try {
    const resp = await getAccounts();
    accounts = resp?.data || resp?.accounts || (Array.isArray(resp) ? resp : []);
  } catch (e) {
    console.error(`FAIL (auth): ${e.code || ""} ${e.message}`.trim());
    console.error("→ 401 usually means a bad token or the legacy header isn't accepted; check FRAMEIO_DEVELOPER_TOKEN and FRAMEIO_AUTH_MODE=legacy.");
    process.exit(1);
  }
  if (!accounts.length) {
    console.error("FAIL (auth): 200 but no accounts returned — token may lack Accounts:Read scope.");
    process.exit(1);
  }
  for (const a of accounts) {
    console.log(`  account: ${a.display_name || a.name || "(unnamed)"} → id ${a.id || a._id}`);
  }
  console.log("PASS (auth): token + headers authenticate against the V4 API.");

  // 2. Optional media-endpoint check — the exact call the worker makes.
  if (!fileId) {
    console.log("No file id supplied — skipping the media-endpoint test.");
    console.log("Re-run with a real file id (arg or FRAMEIO_TEST_FILE_ID) to confirm the worker can resolve media_links.original.download_url.");
    process.exit(0);
  }
  try {
    const r = await getOriginalMediaUrl(fileId);
    console.log(`PASS (media): file ${fileId}`);
    console.log(`  download host: ${hostOf(r.downloadUrl)}`);
    console.log(`  name=${r.name || "?"}  type=${r.fileType || "?"}  size=${r.fileSize ?? "?"}  versionId=${r.versionId || "?"}`);
    process.exit(0);
  } catch (e) {
    console.error(`FAIL (media): ${e.code || ""} ${e.message}`.trim());
    console.error("→ Auth worked but the file fetch didn't. Check the file id, that the token has Assets:Read, and that the file belongs to the configured FRAMEIO_ACCOUNT_ID.");
    process.exit(1);
  }
}

main();
