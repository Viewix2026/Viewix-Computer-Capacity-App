#!/usr/bin/env node
/* Viewix enterprise proposal generator.
   Fills the keyed HTML template from a proposal brief (JSON) and renders a
   client-facing PDF via headless Chrome (deck-stage.js paginates one slide/page).

   Usage:
     node generate.mjs --brief data/acciona.brief.json --out out/ACCIONA.pdf [--look wall] [--keep]

   No npm dependencies: the fill runs in the browser (template/fill.js); we render
   with the installed Chrome. A leftover-token preflight runs first via --dump-dom.
*/
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, 'template');
const TEMPLATE = join(TEMPLATE_DIR, 'proposal-template.html');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const briefPath = arg('brief');
const outPath = arg('out', join(__dirname, 'out', 'proposal.pdf'));
const lookOverride = arg('look');
const keep = !!arg('keep', false);
if (!briefPath) { console.error('ERROR: --brief <path> is required'); process.exit(1); }

const brief = JSON.parse(readFileSync(resolve(briefPath), 'utf8'));
if (lookOverride && typeof lookOverride === 'string') brief.lookVariant = lookOverride;

// --- copy-fit warnings: long text clips silently on a fixed 1920x1080 slide ---
const BUDGETS = [
  ['client.name', 28], ['project.name', 34], ['cover.promise', 170],
  ['brief.para1', 340], ['brief.para2', 360], ['approach.intro', 360],
];
function at(obj, p) { return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
const warns = [];
for (const [p, max] of BUDGETS) { const v = at(brief, p); if (typeof v === 'string' && v.length > max) warns.push(`  ! ${p} is ${v.length} chars (budget ${max}) — may clip; shorten it`); }
(brief.concepts || []).forEach((c, i) => { if ((c.desc || '').length > 150) warns.push(`  ! concepts[${i}].desc is ${c.desc.length} chars (budget 150) — may clip`); });
if (warns.length) console.warn('COPY-FIT WARNINGS (review the PDF for clipping):\n' + warns.join('\n'));

// --- build the render HTML (template + injected brief + fill.js), co-located with assets ---
let html = readFileSync(TEMPLATE, 'utf8');
// Escape so a brief value containing "</script>" or U+2028/9 can't break out of the inline script.
const safeBrief = JSON.stringify(brief).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const inject =
  `<script>window.__BRIEF__=${safeBrief};</script>\n` +
  `<script src="fill.js"></script>\n<script src="deck-stage.js"></script>`;
if (!html.includes('<script src="deck-stage.js"></script>')) {
  console.error('ERROR: template is missing the deck-stage.js script tag'); process.exit(1);
}
html = html.replace('<script src="deck-stage.js"></script>', inject);
const renderHtml = join(TEMPLATE_DIR, '.render.tmp.html');
writeFileSync(renderHtml, html);

const baseFlags = ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--run-all-compositor-stages-before-draw', '--virtual-time-budget=9000'];
const fileUrl = 'file://' + renderHtml;

function cleanup() { if (!keep) { try { rmSync(renderHtml); } catch (e) {} } }

// --- preflight: dump the rendered DOM and check for unfilled / leftover tokens ---
let dom = '';
try {
  dom = execFileSync(CHROME, [...baseFlags, '--dump-dom', fileUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  cleanup(); console.error('ERROR: Chrome --dump-dom failed:', e.message); process.exit(1);
}

const problems = [];
const clientName = brief?.client?.name;
const projectName = brief?.project?.name;
if (!clientName) problems.push('brief.client.name is missing');
if (clientName && !dom.includes(clientName)) problems.push(`client name "${clientName}" did not appear in the rendered deck (fill failed?)`);
if (clientName && clientName !== 'ACCIONA' && dom.includes('ACCIONA')) problems.push('leftover template token "ACCIONA" still in the deck');
if (projectName && projectName !== 'Graduate Program' && dom.includes('Graduate Program')) problems.push('leftover template token "Graduate Program" still in the deck');
if (dom.includes('$00,000')) problems.push('an unconfirmed price placeholder "$00,000" remains — set tier prices in the brief');
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
} catch (e) {
  cleanup(); console.error('ERROR: Chrome --print-to-pdf failed:', e.message); process.exit(1);
}
cleanup();
console.log(`OK — rendered ${clientName} proposal -> ${resolve(outPath)}`);
