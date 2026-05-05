import { EditorDashboardViewix } from "./EditorDashboardViewix";

export function EditorDashboard({ embedded, projects = [], editors = [], clients = [], deliveries = [], accounts = {} }) {
  return (
    <div style={{ fontFamily: "'DM Sans',-apple-system,sans-serif", background: embedded ? "transparent" : "var(--bg)", color: "var(--fg)", minHeight: embedded ? "auto" : "100vh" }}>
      <EditorDashboardViewix projects={projects} editors={editors} clients={clients} deliveries={deliveries} accounts={accounts} />
    </div>
  );
}
