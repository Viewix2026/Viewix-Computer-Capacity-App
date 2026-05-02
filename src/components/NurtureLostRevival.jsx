import { NurtureStubCard } from "./NurtureStubCard";

export function NurtureLostRevival() {
  return (
    <NurtureStubCard
      title="Lost-deal Revival"
      intent="Re-touch deals that went to Lost 6+ months ago. Circumstances change — budget frees up, agencies switch, new initiatives kick off — and the people who said no last year may be the right yes today."
      trigger="Cron — monthly scan of Attio deals in Lost stage where stage transition was 180+ days ago, no other active deal with the same company"
      dataSources="Attio deals (Lost stage), close date, original strongest_connection_user, lost reason if recorded, any newer deals on the same company"
      targetActions="Email + LinkedIn DM — light, no-pressure 'thought of you' touch with one specific reason to reopen the conversation (a new offering, a relevant case study, a market shift)."
    />
  );
}
