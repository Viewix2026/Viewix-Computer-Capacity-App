import { useState } from "react";
import { EditorDashboardViewix } from "./EditorDashboardViewix";
import { TextGenerator } from "./TextGenerator";
import { Segmented } from "./kit";

export function EditorDashboard({ embedded, projects = [], setProjects = null, editors = [], clients = [], deliveries = [], setDeliveries = null, accounts = {}, viewerRole = null, currentUserEmail = null, currentUserName = null }) {
  const [sub, setSub] = useState("Dashboard");
  // Both subtabs stay mounted and are toggled with display so an in-progress
  // caption draft (or the dashboard's scroll/timers) survives a switch.
  return (
    <div style={{ fontFamily: "'DM Sans',-apple-system,sans-serif", background: embedded ? "transparent" : "var(--bg)", color: "var(--fg)", minHeight: embedded ? "auto" : "100vh" }}>
      <div style={{ padding: "10px 28px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
        <Segmented options={["Dashboard", "Text Generator"]} active={sub} onSelect={setSub} />
      </div>
      <div style={{ display: sub === "Dashboard" ? "block" : "none" }}>
        <EditorDashboardViewix projects={projects} setProjects={setProjects} editors={editors} clients={clients} deliveries={deliveries} setDeliveries={setDeliveries} accounts={accounts} viewerRole={viewerRole} currentUserEmail={currentUserEmail} currentUserName={currentUserName} />
      </div>
      <div style={{ display: sub === "Text Generator" ? "block" : "none" }}>
        <TextGenerator />
      </div>
    </div>
  );
}
