import { EditorDashboardViewix } from "./EditorDashboardViewix";

export function EditorDashboard({ embedded, projects = [], setProjects = null, editors = [], clients = [], deliveries = [], setDeliveries = null, accounts = {}, viewerRole = null, currentUserEmail = null, currentUserName = null }) {
  return (
    <div style={{ fontFamily: "'DM Sans',-apple-system,sans-serif", background: embedded ? "transparent" : "var(--bg)", color: "var(--fg)", minHeight: embedded ? "auto" : "100vh" }}>
      <EditorDashboardViewix projects={projects} setProjects={setProjects} editors={editors} clients={clients} deliveries={deliveries} setDeliveries={setDeliveries} accounts={accounts} viewerRole={viewerRole} currentUserEmail={currentUserEmail} currentUserName={currentUserName} />
    </div>
  );
}
