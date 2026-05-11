// api/_email/render.js
// Wraps @react-email/render so callers don't import React directly.
//
// JSX vs React.createElement: Vercel serverless functions (this repo
// uses @vercel/node via Vite) don't have a guaranteed JSX
// transpilation path when /api/ files import from /src/. To eliminate
// that risk for Phase A, every template is authored as plain .js
// using React.createElement (with a tiny `h` alias re-exported from
// `./_h.js`). The end visual is identical to a JSX template; the
// authoring overhead is minor for placeholder bodies. Phase B (real
// designs) can move to .jsx if/when JSX-in-/api/ is verified working.
//
// Adding a new template:
//   1. Create api/_email/templates/<Name>.js
//   2. `export default function Template(props) { return h(...) }`
//   3. Add it to the TEMPLATES map below

import { render } from "@react-email/render";
import * as React from "react";

import Confirmation from "./templates/Confirmation.js";
import ShootTomorrow from "./templates/ShootTomorrow.js";
import InEditSuite from "./templates/InEditSuite.js";
import ReadyForReview from "./templates/ReadyForReview.js";

const TEMPLATES = {
  Confirmation,
  ShootTomorrow,
  InEditSuite,
  ReadyForReview,
};

/**
 * Render a templated email to HTML.
 * @param {string} templateName
 * @param {object} props
 * @returns {Promise<string>}
 */
export async function renderEmailHtml(templateName, props) {
  const Template = TEMPLATES[templateName];
  if (!Template) throw new Error(`Unknown template: ${templateName}`);
  const element = React.createElement(Template, props);
  // @react-email/render returns a Promise<string> on v1+
  return render(element, { pretty: false });
}

export { TEMPLATES };
