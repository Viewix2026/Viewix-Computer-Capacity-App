import { NurtureStubCard } from "./NurtureStubCard";

export function NurtureLeadReengagement() {
  return (
    <NurtureStubCard
      title="Lead Re-engagement"
      intent="Re-engage Leads or Meeting-Booked deals that have gone cold (no stage movement in 21+ days). Lighter touch than the Lapsed Proposals sequence — the goal is to surface whether the lead is still considering us, not to push hard."
      trigger="Cron — daily scan of Attio deals in Lead or Meeting Booked stage with updated_at more than 21 days ago"
      dataSources="Attio deals (Lead, Meeting Booked stages), associated company name, primary contact email, owner"
      targetActions="Single email touch — 'still considering us?' — with calendar link. No SMS or LinkedIn for cold leads (signal-to-noise too low)."
    />
  );
}
