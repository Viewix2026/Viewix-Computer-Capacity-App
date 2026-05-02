import { NurtureStubCard } from "./NurtureStubCard";

export function NurtureWinBack() {
  return (
    <NurtureStubCard
      title="Win-Back (churned customers)"
      intent="Re-pitch ex-customers who haven't bought again in 6/12+ months. They already know the product and the team — the cost of re-engaging them is far lower than acquiring a fresh prospect, and the trust is partially banked."
      trigger="Cron — monthly scan of Attio companies whose most-recent Won deal closed 180+ days ago AND no active Won deal currently in the pipeline"
      dataSources="Attio companies, all associated deals, last Won deal close date, account manager, any deliverables Drive folder"
      targetActions="Email + LinkedIn DM — surface a new offering they didn't have access to before, plus a 'we'd love to work with you again' note from the original owner."
    />
  );
}
