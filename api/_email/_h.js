// api/_email/_h.js
// Tiny alias for React.createElement so template files read like JSX
// without needing a JSX transpiler step in the Vercel runtime.
//
// Use:
//   import { h } from "../_h.js";
//   h("div", { style: { color: "red" } }, "Hello")
//
// Equivalent JSX would be:
//   <div style={{ color: "red" }}>Hello</div>
//
// React Email components (Container, Section, etc.) work the same way:
//   h(Section, { style: ... }, h(Text, null, "body"))

import * as React from "react";

export const h = React.createElement;
export const Fragment = React.Fragment;
export default h;
