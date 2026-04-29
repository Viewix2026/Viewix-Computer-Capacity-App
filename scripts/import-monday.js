#!/usr/bin/env node
/* eslint-disable no-console */
//
// scripts/import-monday.js
//
// One-shot import of a Monday.com Video Production xlsx export into
// /projects + /projects/{id}/subtasks. See plans/happy-foraging-parrot.md
// for the full design.
//
// Usage:
//   node scripts/import-monday.js <path-to-xlsx>            # writes
//   node scripts/import-monday.js <path-to-xlsx> --dry-run  # prints, no writes
//
// Requires FIREBASE_SERVICE_ACCOUNT env var (same JSON the API
// endpoints use). Add it to your local .env or export inline before
// running.
//
// The script is idempotent: a second run finds existing matches and
// fills only empty fields, and skips subtask creation entirely if
// the project already has source: "mondayImport" subtasks.

import XLSX from "xlsx";
import { adminGet, adminSet, adminPatch, getAdmin } from "../api/_fb-admin.js";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ─── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const xlsxPath = args.find(a => !a.startsWith("--"));

if (!xlsxPath) {
  console.error("Usage: node scripts/import-monday.js <xlsx-path> [--dry-run]");
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────
function rid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

function nowISO() {
  return new Date().toISOString();
}

// "Client:\nProject Name" or "Client : Project Name" or "Client - Project"
// or just "Project Name" (no client). Returns { clientName, projectName }.
function splitName(raw) {
  const s = String(raw || "").trim();
  if (!s) return { clientName: "", projectName: "" };
  // Prefer first colon, then first newline.
  let idx = s.indexOf(":");
  if (idx === -1) idx = s.indexOf("\n");
  if (idx === -1) {
    return { clientName: "", projectName: s };
  }
  const clientName = s.slice(0, idx).trim();
  const projectName = s.slice(idx + 1).trim().replace(/^\n+/, "");
  return { clientName, projectName };
}

// Parse xlsx date cell. xlsx returns either a JS Date, a number
// (Excel serial), or a string. Normalise to ISO yyyy-mm-dd in local
// time. Returns null if not parseable.
function parseDate(v) {
  if (!v && v !== 0) return null;
  let d;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === "number") {
    // Excel serial: days since 1899-12-30. SheetJS handles this if
    // cellDates: true at load time, but be defensive.
    const ms = (v - 25569) * 86400 * 1000;
    d = new Date(ms);
  } else if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    d = new Date(t);
  } else {
    return null;
  }
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Same but returns ISO with time (for createdAt etc).
function parseDateTimeISO(v) {
  if (!v && v !== 0) return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date((v - 25569) * 86400 * 1000);
  else if (typeof v === "string") d = new Date(v);
  else return null;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normaliseStatus(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (s === "IN PROGRESS") return "inProgress";
  if (s === "DONE")        return "done";
  if (s === "STUCK")       return "stuck";
  if (s === "ON HOLD" || s === "HOLD") return "onHold";
  if (s === "WAITING ON CLIENT" || s === "WAITING") return "waitingClient";
  if (s === "SCHEDULED")   return "scheduled";
  return "notStarted";
}

function normaliseStage(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "edit") return "edit";
  if (s === "shoot") return "shoot";
  if (s === "pre production" || s === "preproduction" || s === "pre-production") return "preProduction";
  if (s === "revisions" || s === "revision") return "revisions";
  if (s === "hold") return "hold";
  return "preProduction";
}

// "Yes"/"No"/null → boolean | null
function ynToBool(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "yes") return true;
  if (s === "no") return false;
  return null;
}

// "52 hours" / "8" / null → number | null
function parseHours(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Names that aren't actual humans — produced by Monday quirks like
// deactivated accounts ("Deleted member"), status keywords leaking
// from misaligned subitem columns (filtered out before this point
// but kept here as belt + braces), or column header bleeds.
const NON_PERSON_NAMES = new Set([
  "deleted member", "not started",
  "in progress", "done", "stuck", "scheduled",
  "on hold", "hold", "waiting on client", "waiting",
  "status", "stage", "people",
]);

// Resolve "Jeremy Farrugia, Steve Chestney" against /editors. Returns
// { ids: [...], unresolved: [...] }. Unresolved sink only collects
// names that look like real people — filters out Monday meta-strings.
function resolveAssignees(rawPeople, editorsByName) {
  if (!rawPeople) return { ids: [], unresolved: [] };
  const names = String(rawPeople).split(/[,;\n]/).map(n => n.trim()).filter(Boolean);
  const ids = [];
  const unresolved = [];
  for (const n of names) {
    if (NON_PERSON_NAMES.has(n.toLowerCase())) continue;
    const id = editorsByName.get(n.toLowerCase());
    if (id) ids.push(id);
    else unresolved.push(n);
  }
  return { ids, unresolved };
}

// ─── XLSX parser ───────────────────────────────────────────────────
//
// The Monday export packs everything into a single sheet with section
// titles ("Uncommissioned 🎬", "In Progress 🎥", "Done ✅", etc.) on
// their own row, followed by a header row, then alternating
// (parent row, "Subitems" header row, N subitem rows, parent row, ...).
//
// We rebuild that structure by walking row-by-row.
function parseSheet(filePath) {
  console.log(`Reading ${filePath}…`);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Each parent block starts when we hit a row whose column G (index 6)
  // is one of the parent-status keywords AND column H (index 7) is
  // "Parent" (per the export).
  const wantedSections = new Set(["In Progress 🎥", "Done ✅"]);
  const parents = [];
  let currentSection = null;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];
    const cellA = row[0];
    // Section header detection: only first cell is a non-empty string.
    const nonEmptyCols = row.filter(c => c != null && c !== "");
    if (typeof cellA === "string" && nonEmptyCols.length === 1) {
      currentSection = cellA.trim();
      i++;
      continue;
    }
    // Skip the header row "Name | Subitems | Start Date | …"
    if (cellA === "Name" && row[1] === "Subitems") {
      i++;
      continue;
    }
    // Parent row detection: STAGE column (index 7) === "Parent"
    if (row[7] === "Parent") {
      const include = currentSection && wantedSections.has(currentSection);
      const parent = {
        section: currentSection,
        // Verbatim columns; mapping happens later.
        name:                row[0],
        startDate:           row[2],
        dueDate:             row[3],
        timelineStart:       row[4],
        timelineEnd:         row[5],
        status:              row[6],
        people:              row[8],
        projectDueDate:      row[9],
        preShootEmail:       row[10],
        editSuiteEmail:      row[11],
        clientFirstName:     row[12],
        clientEmail:         row[13],
        type:                row[14],
        taskContent:         row[15],
        dateCreated:         row[16],
        attioCompanyId:      row[17],
        briefFormUrl:        row[18],
        briefUrl:            row[19],
        formula:             row[20],
        estimatedEditTime:   row[21],
        subitems: [],
        rowIndex: i + 1,
      };
      i++;
      // Subitem header row right after the parent.
      if (i < rows.length && (rows[i] || [])[0] === "Subitems") {
        i++;
      }
      // Collect subitems until the next parent or section break or
      // blank "section" row.
      while (i < rows.length) {
        const sr = rows[i] || [];
        const srA = sr[0];
        const srH = sr[7];
        const srNon = sr.filter(c => c != null && c !== "");
        // Section header (single non-empty col with string)
        if (typeof srA === "string" && srNon.length === 1) break;
        // Header row "Name | Subitems | …"
        if (srA === "Name" && sr[1] === "Subitems") break;
        // Next parent
        if (srH === "Parent") break;
        // Blank row → skip
        if (srNon.length === 0) { i++; continue; }
        // Subitem row layout (verified against the export's inner
        // header row at "Subitems / Name / Start Date / Due date /
        // Start Time / Finish Time / Timeline - Start / Timeline -
        // End / STATUS / STAGE / People / Client Email / Color / Hour
        // / Frame.io Link / Editor Comments / Checkbox").
        // Note: subitem columns are offset DIFFERENTLY from parent
        // rows — STATUS/STAGE/People sit at indices 8/9/10 here, not
        // 6/7/8 like the parent layout.
        parent.subitems.push({
          name:           sr[1],
          startDate:      sr[2],
          dueDate:        sr[3],
          startTime:      sr[4],
          finishTime:     sr[5],
          timelineStart:  sr[6],
          timelineEnd:    sr[7],
          status:         sr[8],
          stage:          sr[9],
          people:         sr[10],
          frameIoLink:    sr[14],
        });
        i++;
      }
      if (include && parent.name) {
        parents.push(parent);
      }
      continue;
    }
    i++;
  }
  return parents;
}

// ─── Map a Monday parent to the /projects schema ──────────────────
function buildProjectFromParent(p, editorsByName, unresolvedSink) {
  const { clientName, projectName } = splitName(p.name);
  const status = normaliseStatus(p.status);
  const dueDate = parseDate(p.projectDueDate) || parseDate(p.dueDate) || parseDate(p.timelineEnd);
  const closeDate = parseDate(p.startDate) || parseDate(p.timelineStart) || parseDate(p.dateCreated);
  const createdAt = parseDateTimeISO(p.dateCreated) || nowISO();
  const { ids: assigneeIds, unresolved } = resolveAssignees(p.people, editorsByName);
  unresolved.forEach(n => unresolvedSink.add(n));

  const clientContact = (p.clientFirstName || p.clientEmail) ? {
    firstName: p.clientFirstName || "",
    email: p.clientEmail || "",
  } : null;

  const estimatedEditHours = parseHours(p.estimatedEditTime);

  return {
    clientName,
    projectName,
    status,
    videoType: p.type || "",
    description: p.taskContent || "",
    dueDate,
    closeDate,
    clientContact,
    attioCompanyId: p.attioCompanyId || null,
    estimatedEditTime: p.estimatedEditTime || null,
    estimatedEditHours,
    briefUrl: p.briefUrl || null,
    briefFormUrl: p.briefFormUrl || null,
    preShootEmailSent: ynToBool(p.preShootEmail),
    editSuiteEmailSent: ynToBool(p.editSuiteEmail),
    links: {
      accountId: p.attioCompanyId || null,
      assigneeIds,
    },
    createdAt,
    source: "mondayImport",
    importedAt: nowISO(),
  };
}

function buildSubtasksFromSubitems(subitems, editorsByName, unresolvedSink) {
  const out = [];
  subitems.forEach((s, i) => {
    if (!s.name) return;
    const { ids, unresolved } = resolveAssignees(s.people, editorsByName);
    unresolved.forEach(n => unresolvedSink.add(n));
    const start = parseDate(s.startDate) || parseDate(s.timelineStart);
    const end   = parseDate(s.dueDate)   || parseDate(s.timelineEnd) || start;
    const stId = `mst-${String(i).padStart(3, "0")}-${randomBytes(2).toString("hex")}`;
    out.push({
      id: stId,
      name: s.name,
      stage: normaliseStage(s.stage),
      status: normaliseStatus(s.status),
      startDate: start,
      endDate: end,
      startTime: null,
      endTime: null,
      assigneeIds: ids,
      assigneeId: ids[0] || null,
      frameIoLink: s.frameIoLink || null,
      source: "mondayImport",
      order: i,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  });
  return out;
}

// ─── Match strategy ───────────────────────────────────────────────
function findExistingProjectId(parent, projectsByAttio, projectsByNameKey) {
  if (parent.attioCompanyId) {
    const id = projectsByAttio.get(String(parent.attioCompanyId));
    if (id) return id;
  }
  const { clientName, projectName } = splitName(parent.name);
  if (clientName && projectName) {
    const key = `${clientName.toLowerCase()}|${projectName.toLowerCase()}`;
    const id = projectsByNameKey.get(key);
    if (id) return id;
  }
  return null;
}

// Conservative merge: only fill missing fields. Producer edits win.
function mergeFields(existing, incoming) {
  const patch = {};
  // Keep existing status if it was edited (anything other than the
  // defaultish "notStarted" placeholder); otherwise accept incoming.
  if (!existing.status || existing.status === "notStarted") {
    if (incoming.status) patch.status = incoming.status;
  }
  const fillIfEmpty = (key) => {
    const cur = existing[key];
    const next = incoming[key];
    const isEmpty = cur == null || cur === "" || (Array.isArray(cur) && cur.length === 0);
    if (isEmpty && next != null && next !== "") patch[key] = next;
  };
  fillIfEmpty("clientName");
  fillIfEmpty("projectName");
  fillIfEmpty("videoType");
  fillIfEmpty("description");
  fillIfEmpty("dueDate");
  fillIfEmpty("closeDate");
  fillIfEmpty("attioCompanyId");
  fillIfEmpty("estimatedEditTime");
  fillIfEmpty("estimatedEditHours");
  fillIfEmpty("briefUrl");
  fillIfEmpty("briefFormUrl");
  if (existing.preShootEmailSent == null && incoming.preShootEmailSent != null) patch.preShootEmailSent = incoming.preShootEmailSent;
  if (existing.editSuiteEmailSent == null && incoming.editSuiteEmailSent != null) patch.editSuiteEmailSent = incoming.editSuiteEmailSent;
  if (!existing.clientContact && incoming.clientContact) patch.clientContact = incoming.clientContact;
  // Merge links carefully — never blow away existing links.assigneeIds
  const existingLinks = existing.links || {};
  const linksPatch = {};
  if (!existingLinks.accountId && incoming.links?.accountId) linksPatch.accountId = incoming.links.accountId;
  if ((!existingLinks.assigneeIds || existingLinks.assigneeIds.length === 0) && incoming.links?.assigneeIds?.length) {
    linksPatch.assigneeIds = incoming.links.assigneeIds;
  }
  if (Object.keys(linksPatch).length > 0) patch.links = { ...existingLinks, ...linksPatch };
  // Always stamp source + importedAt so we can audit.
  patch.source = existing.source === "mondayImport" ? "mondayImport" : (existing.source || "mondayImport");
  patch.importedAt = nowISO();
  return patch;
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const startedAt = nowISO();
  const startedAtMs = Date.now();
  const absXlsx = path.resolve(xlsxPath);

  // Sanity-check Firebase admin (also surfaces missing FIREBASE_SERVICE_ACCOUNT early).
  if (!dryRun) {
    const { err } = getAdmin();
    if (err) {
      console.error(`Firebase admin init failed: ${err}`);
      console.error("Set FIREBASE_SERVICE_ACCOUNT in your env (the JSON service-account blob) and retry.");
      process.exit(1);
    }
  }

  const parents = parseSheet(absXlsx);
  console.log(`Parsed ${parents.length} parents from Monday export.`);
  const counts = parents.reduce((a, p) => {
    if (p.section === "In Progress 🎥") a.inProgress++;
    else if (p.section === "Done ✅") a.done++;
    return a;
  }, { inProgress: 0, done: 0 });
  console.log(`  In Progress: ${counts.inProgress}    Done: ${counts.done}`);

  // Pull existing /editors + /projects for matching.
  let editors = {}, projects = {};
  if (dryRun) {
    try { editors = (await adminGet("/editors")) || {}; }
    catch { editors = {}; console.log("[dry-run] could not read /editors (will only resolve names if ENV set)"); }
    try { projects = (await adminGet("/projects")) || {}; }
    catch { projects = {}; console.log("[dry-run] could not read /projects (assuming none exist)"); }
  } else {
    editors = (await adminGet("/editors")) || {};
    projects = (await adminGet("/projects")) || {};
  }
  const editorsArr = Array.isArray(editors) ? editors : Object.values(editors);
  const editorsByName = new Map(
    editorsArr.filter(Boolean).map(e => [(e.name || "").toLowerCase(), e.id])
  );
  console.log(`Loaded ${editorsByName.size} editors for assignee resolution.`);

  const projectsArr = Object.values(projects).filter(Boolean);
  const projectsByAttio = new Map();
  const projectsByNameKey = new Map();
  for (const p of projectsArr) {
    if (p.attioCompanyId) projectsByAttio.set(String(p.attioCompanyId), p.id);
    if (p.clientName && p.projectName) {
      const key = `${p.clientName.toLowerCase()}|${p.projectName.toLowerCase()}`;
      projectsByNameKey.set(key, p.id);
    }
  }
  console.log(`Loaded ${projectsArr.length} existing /projects records.`);

  // Process each Monday parent.
  const report = {
    startedAt,
    parents: { matched: 0, created: 0, total: 0 },
    subtasks: { created: 0, skippedDoneInline: 0, skippedAlreadyImported: 0, total: 0 },
    unresolvedAssignees: new Set(),
    errors: [],
  };

  let processed = 0;
  for (const parent of parents) {
    processed++;
    if (processed % 100 === 0) console.log(`  …${processed}/${parents.length}`);
    try {
      const incoming = buildProjectFromParent(parent, editorsByName, report.unresolvedAssignees);
      const matchedId = findExistingProjectId(parent, projectsByAttio, projectsByNameKey);

      let projectId;
      if (matchedId) {
        projectId = matchedId;
        const existing = projects[matchedId] || {};
        const patch = mergeFields(existing, incoming);
        if (!dryRun) {
          await adminPatch(`/projects/${projectId}`, patch);
        }
        report.parents.matched++;
      } else {
        projectId = rid("monday");
        const newRecord = { id: projectId, ...incoming };
        if (!dryRun) {
          await adminSet(`/projects/${projectId}`, newRecord);
        }
        // Add to in-memory indices so a second run inside the same
        // session doesn't double-create the same project.
        projects[projectId] = newRecord;
        projectsByNameKey.set(`${(incoming.clientName || "").toLowerCase()}|${(incoming.projectName || "").toLowerCase()}`, projectId);
        if (incoming.attioCompanyId) projectsByAttio.set(String(incoming.attioCompanyId), projectId);
        report.parents.created++;
      }
      report.parents.total++;

      const isDone = parent.section === "Done ✅";
      const subtasks = buildSubtasksFromSubitems(parent.subitems, editorsByName, report.unresolvedAssignees);
      report.subtasks.total += subtasks.length;

      if (isDone) {
        // Done parents: store raw subitems for reporting; don't write subtasks.
        if (!dryRun && subtasks.length > 0) {
          await adminSet(`/projects/${projectId}/mondaySubitems`, subtasks);
        }
        report.subtasks.skippedDoneInline += subtasks.length;
      } else {
        // In-progress parents: create subtasks unless this project
        // already has Monday-imported subtasks (idempotency).
        const existingSubtasks = projects[projectId]?.subtasks || {};
        const alreadyImported = Object.values(existingSubtasks).some(
          st => st && st.source === "mondayImport"
        );
        if (alreadyImported) {
          report.subtasks.skippedAlreadyImported += subtasks.length;
        } else if (subtasks.length > 0) {
          if (!dryRun) {
            // Build a single-shot map write so the listener fires once
            // per project rather than per subtask.
            const map = {};
            for (const st of subtasks) map[st.id] = st;
            await adminPatch(`/projects/${projectId}/subtasks`, map);
          }
          report.subtasks.created += subtasks.length;
        }
      }
    } catch (e) {
      report.errors.push({ parent: parent.name, error: e.message });
      console.error(`! Error processing "${parent.name}":`, e.message);
    }
  }

  const finishedAt = nowISO();
  const durationMs = Date.now() - startedAtMs;
  const summary = {
    startedAt,
    finishedAt,
    durationMs,
    dryRun,
    parents: report.parents,
    subtasks: report.subtasks,
    unresolvedAssignees: Array.from(report.unresolvedAssignees).sort(),
    errors: report.errors,
  };

  console.log("");
  console.log("══════ IMPORT SUMMARY ══════");
  console.log(`mode:               ${dryRun ? "DRY RUN (no writes)" : "LIVE WRITE"}`);
  console.log(`duration:           ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`parents matched:    ${summary.parents.matched}`);
  console.log(`parents created:    ${summary.parents.created}`);
  console.log(`parents total:      ${summary.parents.total}`);
  console.log(`subtasks created:   ${summary.subtasks.created}`);
  console.log(`subtasks skipped (done inline storage): ${summary.subtasks.skippedDoneInline}`);
  console.log(`subtasks skipped (already imported):    ${summary.subtasks.skippedAlreadyImported}`);
  console.log(`unresolved assignees: ${summary.unresolvedAssignees.length}`);
  if (summary.unresolvedAssignees.length) {
    console.log("  (these names didn't match any /editors entry):");
    for (const n of summary.unresolvedAssignees) console.log(`    - ${n}`);
  }
  if (summary.errors.length) {
    console.log(`errors:             ${summary.errors.length}`);
    for (const e of summary.errors.slice(0, 10)) console.log(`    - ${e.parent}: ${e.error}`);
  }

  if (!dryRun) {
    try {
      await adminSet("/foundersData/lastMondayImport", summary);
    } catch (e) {
      console.warn("Could not write summary to /foundersData/lastMondayImport:", e.message);
    }
  }

  console.log("");
  console.log(dryRun ? "Dry run complete. Re-run without --dry-run to write." : "DONE.");
  process.exit(summary.errors.length > 0 ? 2 : 0);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
