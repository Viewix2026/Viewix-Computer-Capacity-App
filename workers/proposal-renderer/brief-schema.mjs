// Shared validator for the canonical FLAT proposal brief — the exact schema
// skills/viewix-enterprise-proposal/{generate.mjs,template/fill.js} consume
// (see data/*.brief.json for worked examples). Used three times:
//   Stage A  — validate Claude's draft (requirePrices: false; prices stay "$00,000")
//   Approve  — the dashboard mirrors these checks before allowing approval
//   Stage B  — re-validate the founder-approved brief (requirePrices: true)
// Returns { ok, errors[], flags[] }. Errors block; flags surface in the
// review panel (untrusted-transcript content: URLs, emails, instruction-y text).

export const LOOK_VARIANTS = ["wall", "strip", "hero", "colour", "desk"];
export const MONEY_RE = /^\$\d{1,3}(,\d{3})*$/;
const PLACEHOLDER_PRICE_RE = /^\$0?0,000$/;

// Mirrors generate.mjs copy-fit budgets (clipping warnings, not hard errors there;
// hard errors here because the worker can just re-prompt for shorter copy).
const LENGTH_BUDGETS = {
  "client.name": 28, "project.name": 34, "cover.promise": 170,
  "brief.para1": 340, "brief.para2": 360, "approach.intro": 360,
};

const FLAG_RE = /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions|system\s+prompt|<\s*script)/i;

function at(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function isFilled(v) { return typeof v === "string" && v.trim().length > 0; }

// Copy-fit budgets mirror generate.mjs, which only WARNS at these thresholds —
// real clipping starts well past them. So a small overrun (≤15%) is a review
// flag the founder can trim, not a hard rejection; egregious overruns fail.
function budgetCheck(path, v, max, errors, flags) {
  if (typeof v !== "string") return;
  if (v.length > Math.ceil(max * 1.15)) errors.push(`${path} is ${v.length} chars (budget ${max}) — far too long, will clip`);
  else if (v.length > max) flags.push(`${path} is ${v.length} chars (budget ${max}) — slightly long, trim before approving`);
}

export function validateBrief(brief, { requirePrices = false } = {}) {
  const errors = [];
  const flags = [];
  if (!brief || typeof brief !== "object") return { ok: false, errors: ["brief is not an object"], flags };

  const requireStr = (path) => {
    if (!isFilled(at(brief, path))) errors.push(`${path} is missing or empty`);
  };

  ["client.name", "project.name", "project.titleHtml", "proposal.date", "cover.promise",
   "brief.para1", "brief.para2", "approach.intro", "nextSteps.tagline"].forEach(requireStr);

  if (!LOOK_VARIANTS.includes(brief.lookVariant)) errors.push(`lookVariant must be one of ${LOOK_VARIANTS.join("/")}`);

  const success = at(brief, "brief.success");
  if (!Array.isArray(success) || success.length !== 3) errors.push("brief.success must be an array of exactly 3 items");
  else success.forEach((s, i) => {
    if (!isFilled(s?.title)) errors.push(`brief.success[${i}].title missing`);
    if (!isFilled(s?.desc)) errors.push(`brief.success[${i}].desc missing`);
  });

  const concepts = brief.concepts;
  if (!Array.isArray(concepts) || concepts.length < 3 || concepts.length > 4) {
    errors.push("concepts must be an array of 3 or 4 items");
  } else concepts.forEach((c, i) => {
    ["lbl", "title", "channel", "desc", "ref"].forEach((k) => {
      if (!isFilled(c?.[k])) errors.push(`concepts[${i}].${k} missing`);
    });
    budgetCheck(`concepts[${i}].desc`, c?.desc, 150, errors, flags);
  });

  for (const t of ["1", "2", "3"]) {
    const tier = at(brief, `tier.${t}`) || {};
    if (!isFilled(tier.name)) errors.push(`tier.${t}.name missing`);
    if (!isFilled(tier.bestFor)) errors.push(`tier.${t}.bestFor missing`);
    const p = tier.price;
    if (requirePrices) {
      if (!isFilled(p) || !MONEY_RE.test(p) || PLACEHOLDER_PRICE_RE.test(p)) {
        errors.push(`tier.${t}.price must be confirmed money like "$38,000" (got ${JSON.stringify(p ?? null)})`);
      }
    } else if (isFilled(p) && !PLACEHOLDER_PRICE_RE.test(p)) {
      // Drafts must NEVER carry invented dollars — placeholder only.
      errors.push(`tier.${t}.price must stay "$00,000" in a draft (got ${JSON.stringify(p)})`);
    }
  }

  for (const [path, max] of Object.entries(LENGTH_BUDGETS)) {
    budgetCheck(path, at(brief, path), max, errors, flags);
  }

  // Flag-don't-block scan of client-facing copy (founder review is the backstop).
  const clientFacing = [
    ["cover.promise", at(brief, "cover.promise")], ["brief.para1", at(brief, "brief.para1")],
    ["brief.para2", at(brief, "brief.para2")], ["approach.intro", at(brief, "approach.intro")],
    ["nextSteps.tagline", at(brief, "nextSteps.tagline")],
    ...(Array.isArray(success) ? success.flatMap((s, i) => [[`brief.success[${i}].title`, s?.title], [`brief.success[${i}].desc`, s?.desc]]) : []),
    ...(Array.isArray(concepts) ? concepts.flatMap((c, i) => [[`concepts[${i}].title`, c?.title], [`concepts[${i}].desc`, c?.desc]]) : []),
  ];
  for (const [path, v] of clientFacing) {
    if (typeof v === "string" && FLAG_RE.test(v)) flags.push(`${path} contains a URL/email/instruction-like fragment — check before approving`);
  }

  return { ok: errors.length === 0, errors, flags };
}

// Strip the review-only envelope before the brief touches the renderer
// (generate.mjs preflight scans the rendered DOM — provenance text must not enter it).
export function toRenderBrief(brief) {
  const { _meta, ...render } = brief || {};
  return render;
}
