#!/usr/bin/env node
/* Viewix Meta Ads report generator.
   Fills the keyed HTML report template from a data JSON (pulled from the Meta Ads
   MCP) and renders a PDF via headless Google Chrome. No npm dependencies — the
   fill runs in the browser (template/fill.js); render uses the installed Chrome.

   Usage:
     node generate.mjs --data data/boost-tutoring.json --out out/Boost-Tutoring-Meta-Report.pdf [--keep]

   Override Chrome:  CHROME=/path/to/chrome node generate.mjs ...
*/
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, 'template');
const TEMPLATE = join(TEMPLATE_DIR, 'report.html');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const dataPath = arg('data', join(__dirname, 'data', 'boost-tutoring.json'));
const outPath = arg('out', join(__dirname, 'out', 'Meta-Ads-Report.pdf'));
const keep = !!arg('keep', false);

const data = JSON.parse(readFileSync(resolve(dataPath), 'utf8'));

// --- sanity: required shape before we spend a render ---
const shapeProblems = [];
if (!data.client) shapeProblems.push('data.client is missing');
if (!data.generated_label) shapeProblems.push('data.generated_label is missing (the timestamp stamp)');
if (!Array.isArray(data.accounts) || !data.accounts.length) shapeProblems.push('data.accounts is empty');
(data.accounts || []).forEach((a, i) => {
  if (!a.name) shapeProblems.push(`accounts[${i}].name is missing`);
  if (!a.totals || a.totals.spend == null) shapeProblems.push(`accounts[${i}].totals.spend is missing`);
  if (!Array.isArray(a.campaigns)) shapeProblems.push(`accounts[${i}].campaigns is not an array`);
});
if (shapeProblems.length) {
  console.error('PREFLIGHT FAILED — not rendering:\n' + shapeProblems.map(p => '  - ' + p).join('\n'));
  process.exit(2);
}

// --- build the render HTML (template + injected data + fill.js) ---
// Escape so a value containing "</script>" or the U+2028/U+2029 line separators
// (built via RegExp to avoid embedding the raw chars in this source) can't break
// out of the inline <script>.
let html = readFileSync(TEMPLATE, 'utf8');
const LS = new RegExp('\\u2028', 'g');
const PS = new RegExp('\\u2029', 'g');
const safeData = JSON.stringify(data)
  .replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');
const inject = `<script>window.__DATA__=${safeData};</script>\n<script src="fill.js"></script>`;
if (!html.includes('<script src="fill.js"></script>')) {
  console.error('ERROR: template is missing the fill.js script tag'); process.exit(1);
}
html = html.replace('<script src="fill.js"></script>', inject);

const renderHtml = join(TEMPLATE_DIR, `.render.${Date.now()}-${process.pid}.tmp.html`);
writeFileSync(renderHtml, html);

const baseFlags = ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--run-all-compositor-stages-before-draw', '--virtual-time-budget=10000'];
const fileUrl = 'file://' + renderHtml;
function cleanup() { if (!keep) { try { rmSync(renderHtml); } catch (e) {} } }

// --- preflight: dump rendered DOM, confirm the fill bound and no sample tokens leaked ---
let dom = '';
try {
  dom = execFileSync(CHROME, [...baseFlags, '--dump-dom', fileUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) { cleanup(); console.error('ERROR: Chrome --dump-dom failed:', e.message); process.exit(1); }

const problems = [];
if (!/<body[^>]*class="[^"]*\bready\b/.test(dom)) problems.push('fill.js did not run to completion (no body.ready)');
if (!dom.includes(data.client)) problems.push(`client "${data.client}" did not render (fill failed?)`);
// Catch top-level bind failures the client name alone can hide: a summary value must appear.
const probe = data.summary && data.summary.spend;
if (probe && !dom.includes(probe)) problems.push(`summary.spend "${probe}" did not render — top-level fields not binding`);
if (data.client !== 'Boost Tutoring Australia' && dom.includes('Boost Tutoring Australia'))
  problems.push('leftover sample client "Boost Tutoring Australia" still in the report');
if (dom.includes('{{')) problems.push('stray "{{" placeholder found');
if (problems.length) {
  cleanup();
  console.error('PREFLIGHT FAILED — not rendering:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(2);
}

// --- render the PDF ---
mkdirSync(dirname(resolve(outPath)), { recursive: true });
try {
  execFileSync(CHROME, [...baseFlags, '--no-pdf-header-footer', '--print-to-pdf=' + resolve(outPath), fileUrl], { stdio: 'pipe' });
} catch (e) { cleanup(); console.error('ERROR: Chrome --print-to-pdf failed:', e.message); process.exit(1); }
cleanup();
console.log(`OK — rendered ${data.client} Meta Ads report -> ${resolve(outPath)}`);
