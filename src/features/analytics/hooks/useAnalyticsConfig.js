// useAnalyticsConfig — per-account analytics configuration.
//
// Reads /analytics/clients/{accountId}/config and exposes:
//   - the current config (or a default-shaped empty object)
//   - updateConfig(patch) — merge a partial update + write to Firebase
//   - the loading state
//
// The "Enable analytics" toggle writes config.enabled. Until that's
// true, no scraping ever fires for this account — the schedule
// handler in api/cron/analytics-schedule.js gates on this exact
// field, so the toggle is the single source of truth for "should
// this account cost us money."
//
// Writes go through fbSet, not a debounced bulk writer — config
// edits are infrequent and we want them durable immediately so a
// page refresh doesn't lose a producer's typing.

import { useEffect, useState } from "react";
import { initFB, onFB, fbListen, fbSet } from "../../../firebase";
import { PLATFORMS } from "../config/constants";

// Default config shape for an account that hasn't been touched yet.
// Returning a stable object means the form always has fields to
// bind to even before the first write lands.
function emptyConfig(accountId, companyName) {
  const platforms = {};
  PLATFORMS.forEach(p => { platforms[p.key] = false; });
  return {
    accountId,
    companyName: companyName || "",
    enabled: false,
    platforms,
    handles: { instagram: "", tiktok: "", youtube: "" },
    competitors: { instagram: [], tiktok: [], youtube: [] },
    niche: { freeText: "" },
    updatedAt: null,
    updatedBy: null,
  };
}

export function useAnalyticsConfig(accountId, companyName) {
  const [config, setConfig] = useState(() => emptyConfig(accountId, companyName));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return undefined;
    initFB();
    let unsub = () => {};
    let cancelled = false;
    onFB(() => {
      if (cancelled) return;
      unsub = fbListen(`/analytics/clients/${accountId}/config`, (data) => {
        if (data) {
          // Merge any persisted values on top of the empty defaults
          // so missing keys (e.g. a new platform added to PLATFORMS
          // after this account was first configured) don't crash
          // the form.
          setConfig({ ...emptyConfig(accountId, companyName), ...data });
        } else {
          setConfig(emptyConfig(accountId, companyName));
        }
        setLoading(false);
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [accountId, companyName]);

  const updateConfig = (patch) => {
    const next = {
      ...config,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    setConfig(next);
    fbSet(`/analytics/clients/${accountId}/config`, next);
  };

  return { config, loading, updateConfig };
}
