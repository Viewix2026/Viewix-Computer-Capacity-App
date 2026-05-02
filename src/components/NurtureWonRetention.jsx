import { NurtureStubCard } from "./NurtureStubCard";

export function NurtureWonRetention() {
  return (
    <NurtureStubCard
      title="Won Retention / Upsell"
      intent="Surface active Won customers approaching renewal, contract end, or post-delivery checkpoint moments to prompt upsell, additional content, or referral conversations before the relationship goes quiet."
      trigger="Cron — weekly scan of Won deals where delivery_completed_at or contract_end_at falls in the next 30 days"
      dataSources="Attio deals (Won stage), Firebase /accounts/{id} milestones, project deliverables count, account manager"
      targetActions="Email from owner — 'how was the experience' + offer to scope the next quarter's content, or a referral ask if the relationship has been strong."
    />
  );
}
