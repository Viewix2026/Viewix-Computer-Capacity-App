#!/usr/bin/env node
/* Upload the rendered report PDF straight into a Slack channel as a real file
   attachment, with an initial summary comment. Uses Slack's modern external-upload
   flow (files.getUploadURLExternal -> PUT -> files.completeUploadExternal). No deps.

   Env:
     SLACK_BOT_TOKEN   xoxb-... bot token with scopes: files:write, chat:write
     SLACK_CHANNEL_ID  the channel id for "Meta Ads Management" (e.g. C0XXXXXXX)
   Usage:
     node post-slack.mjs --pdf out/Boost-Tutoring-Meta-Report.pdf --summary "..." [--title "Meta Ads Report"]
*/
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_CHANNEL_ID;
const pdf = resolve(arg('pdf', 'out/Boost-Tutoring-Meta-Report.pdf'));
const summary = arg('summary', 'Boost Tutoring — Meta ads report attached.');
const title = arg('title', 'Boost Tutoring — Meta Ads Report');

if (!token) { console.error('ERROR: SLACK_BOT_TOKEN is not set'); process.exit(1); }
if (!channel) { console.error('ERROR: SLACK_CHANNEL_ID is not set'); process.exit(1); }

const bytes = readFileSync(pdf);
const size = statSync(pdf).size;
const filename = basename(pdf);

async function slack(method, body, isForm) {
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: isForm
      ? { Authorization: 'Bearer ' + token }
      : { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
    body: isForm ? body : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(method + ' failed: ' + (json.error || 'unknown'));
  return json;
}

// 1) reserve an upload URL
const params = new URLSearchParams({ filename, length: String(size) });
const up = await slack('files.getUploadURLExternal', params, true);

// 2) PUT the bytes to the reserved URL
const put = await fetch(up.upload_url, { method: 'POST', body: bytes });
if (!put.ok) { console.error('ERROR: file PUT failed:', put.status); process.exit(1); }

// 3) finalise into the channel with the summary as the initial comment
await slack('files.completeUploadExternal', {
  files: [{ id: up.file_id, title }],
  channel_id: channel,
  initial_comment: summary,
});

console.log(`OK — posted ${filename} (${(size / 1024).toFixed(0)} KB) to channel ${channel}`);
