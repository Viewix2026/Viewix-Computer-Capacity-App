// Analytics — sidebar tab. Thin wrapper around the feature folder.
//
// Per Jeremy's CLAUDE.md rule "every sidebar tab goes in its own
// src/components/<Feature>.jsx file" — this file is the entry point
// App.jsx imports. The actual feature lives in
// src/features/analytics/ so the analytics codebase can grow without
// bloating src/components/.
//
// Same access pattern as Projects + Pre-Prod (the tabs it sits
// between in the sidebar): founder-tier or lead. Editors / trial /
// closer don't see it — analytics views are intended for operations
// + leadership, not crew. Gating lives in App.jsx; this file just
// renders the feature.

import { AnalyticsApp } from "../features/analytics/AnalyticsApp";

export function Analytics() {
  return <AnalyticsApp />;
}
