// AnalyticsApp — tab root for the Viewix Growth Intelligence
// analytics feature. Renders the command-centre list by default;
// clicking a client opens AnalyticsClientDetail with that client's
// config + (in later phases) live dashboard.
//
// Internal routing is local state, not a router library — keeps
// Phase 1 isolated from App.jsx's hash routing while we're still
// shaping the surface. Deep links via hash can be added in Phase 4
// once the dashboard zones are real.

import { useState } from "react";
import { AnalyticsClientsList } from "./AnalyticsClientsList";
import { AnalyticsClientDetail } from "./AnalyticsClientDetail";

export function AnalyticsApp() {
  const [selectedAccountId, setSelectedAccountId] = useState(null);

  if (selectedAccountId) {
    return (
      <AnalyticsClientDetail
        accountId={selectedAccountId}
        onBack={() => setSelectedAccountId(null)}
      />
    );
  }

  return (
    <AnalyticsClientsList
      onSelect={(accountId) => setSelectedAccountId(accountId)}
    />
  );
}
