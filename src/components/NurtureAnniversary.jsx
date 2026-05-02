import { NurtureStubCard } from "./NurtureStubCard";

export function NurtureAnniversary() {
  return (
    <NurtureStubCard
      title="Anniversary / Milestone"
      intent="Celebrate Won-deal anniversaries (1-year, 2-year) with a check-in + 'what's next' note from the original owner. Low-effort touchpoint that consistently surfaces upsell and referral conversations."
      trigger="Cron — daily scan of Won deals where today is exactly 365 or 730 days after close_date"
      dataSources="Attio deals (Won stage), close date, strongest_connection_user, deal value, project name"
      targetActions="Single email — celebratory tone (not salesy) + offer to refresh the partnership, plan the next quarter, or simply catch up."
    />
  );
}
