// useAccounts — subscribes to /accounts and returns the list of
// records that are eligible to appear in the Analytics command
// centre (partnershipType is set). The analytics codebase reads
// /accounts as a one-way dependency; it never writes back to it.
//
// Eligibility-for-list is intentionally lax (partnershipType set).
// Eligibility-for-scraping is /analytics/clients/{id}/config/enabled
// being true — that gate lives in useAnalyticsConfig and the API
// refresh endpoint. Two distinct states by design.

import { useEffect, useState } from "react";
import { initFB, onFB, fbListen } from "../../../firebase";

export function useAccounts() {
  const [accounts, setAccounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initFB();
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen("/accounts", (data) => {
        setAccounts(data || {});
        setLoading(false);
      });
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  // Filter to records that look like real accounts. partnershipType
  // is the canonical "this is a customer" marker used by the rest
  // of the dashboard.
  const eligible = Object.values(accounts)
    .filter(a => a && a.id && a.partnershipType)
    .sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));

  return { accounts, eligible, loading };
}
