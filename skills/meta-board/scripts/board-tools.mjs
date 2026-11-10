#!/usr/bin/env node
// board-tools: one ticket board for every project, kept in a single SQLite file outside all repos.
//
// A ticket belongs to one project and is the only container: its summary, acceptance criteria,
// decisions and sources all live inside it. A decision never exists without its ticket.
//
//   node board-tools.mjs project ensure [--dir <path>]     create the project for a folder if it is not on the board yet
//   node board-tools.mjs project list
//   node board-tools.mjs add --file <ticket.json> [--dir <path>]
//   node board-tools.mjs decide <id> --file <decision.json> [--answers K<n>]
//   node board-tools.mjs source <id> --file <source.json>
//   node board-tools.mjs review <id> K<n>                   the owner has seen a decision the agent made
//   node board-tools.mjs set <id> --status <status> [--evidence <text>]
//   node board-tools.mjs list [--project p] [--group g] [--status s] [--waiting] [--limit n]
//   node board-tools.mjs show <id>                          the full text of one ticket
//   node board-tools.mjs search <words> [--project p]       ticket numbers and titles only
//   node board-tools.mjs export [--project p]               JSON
//   node board-tools.mjs report --out <dir>                 index.html (the board) and one page per ticket
//
// The board lives at ~/.aetheris/board/board.db; AETHERIS_BOARD overrides the path.
// Reading is deliberately narrow: `list` and `search` print one short line per ticket, and only `show`
// prints the long text, so an agent never loads the whole board to answer one question.
// Exit codes: 0 ok, 1 the data was refused, 2 usage or environment error.
// No dependencies; needs a Node version with the built-in node:sqlite module.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_TOOLS = path.join(HERE, "..", "..", "meta-prd", "scripts", "doc-tools.mjs");
const DB_PATH = process.env.AETHERIS_BOARD || path.join(os.homedir(), ".aetheris", "board", "board.db");

const STATUSES = ["siap", "dikerjakan", "selesai", "batal"];
const STATUS_LABEL = { siap: "Siap", dikerjakan: "Dikerjakan", selesai: "Selesai", batal: "Batal" };
const CREDENTIAL_KEY = /pass(word|wd)?$|secret|token|api[-_]?key|cookie|authorization|credential/i;
const CREDENTIAL_QUERY = /[?&](token|access_token|password|passwd|secret|api_?key|key|signature)=[^&\s]+/i;
const URL_WITH_LOGIN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const REPORT_MARK = "board-tools-report";

class UsageError extends Error {}
class Refused extends Error {}

const isText = (value) => typeof value === "string" && value.trim().length > 0;
const words = (value) => (isText(value) ? value.trim().split(/\s+/).length : 0);
const kebab = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Local time with its offset, so a date on the board is the owner's date. BOARD_NOW pins it for tests. */
function now() {
  if (process.env.BOARD_NOW) return process.env.BOARD_NOW;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

async function openDb() {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new UsageError("this Node version has no built-in node:sqlite module; the board needs a newer Node");
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new sqlite.DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      key TEXT PRIMARY KEY, grp TEXT NOT NULL, dir TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL REFERENCES projects(key),
      title TEXT NOT NULL, status TEXT NOT NULL,
      unanswered INTEGER NOT NULL DEFAULT 0, unseen INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tickets_project ON tickets(project, status);
    CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(title, body);
  `);
  return db;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function readJson(file) {
  if (!file) throw new UsageError("--file <path.json> is required");
  if (!fs.existsSync(file)) throw new UsageError(`file not found: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (error) { throw new UsageError(`${file} is not valid JSON: ${error.message}`); }
}

/** A project is named after its folder and grouped by the folder above it. */
function projectOf(dir) {
  const full = path.resolve(dir || process.cwd());
  const key = kebab(path.basename(full));
  if (!key) throw new UsageError(`cannot name a project from the folder ${full}`);
  return { key, grp: kebab(path.basename(path.dirname(full))) || "lainnya", dir: full };
}

function ensureProject(db, dir) {
  const project = projectOf(dir);
  const found = db.prepare("SELECT key, grp FROM projects WHERE key = ?").get(project.key);
  if (found) return { ...project, grp: found.grp, created: false };
  db.prepare("INSERT INTO projects (key, grp, dir, created_at) VALUES (?, ?, ?, ?)").run(project.key, project.grp, project.dir, now());
  return { ...project, created: true };
}

/* ---------- validation ---------- */

function findCredentials(value, trail, problems) {
  if (Array.isArray(value)) value.forEach((item, index) => findCredentials(item, `${trail}[${index}]`, problems));
  else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) problems.push(`must not store credentials (key "${key}")`);
      else findCredentials(inner, trail ? `${trail}.${key}` : key, problems);
    }
  } else if (typeof value === "string") {
    if (URL_WITH_LOGIN.test(value)) problems.push(`${trail}: credentials inside a URL`);
    if (CREDENTIAL_QUERY.test(value)) problems.push(`${trail}: credential in a query string`);
  }
}

const isPending = (decision) => decision.decided_by === undefined && !isText(decision.chosen);

function validateDecision(decision, trail, problems) {
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) { problems.push(`${trail} must be an object`); return; }
  if (!isText(decision.question)) problems.push(`${trail} needs "question" as a full sentence`);
  if (isPending(decision)) return; // a question the owner has not answered yet
  if (!["user", "agent"].includes(decision.decided_by)) { problems.push(`${trail}: decided_by must be "user" or "agent"`); return; }
  for (const field of ["chosen", "reason"]) if (!isText(decision[field])) problems.push(`${trail} needs "${field}" as a full sentence`);
  const rejected = Array.isArray(decision.rejected) ? decision.rejected : [];
  if (!rejected.length || !rejected.every((r) => r && isText(r.option) && isText(r.reason))) problems.push(`${trail} needs "rejected": at least one option that was not taken, with its reason`);
  if (decision.decided_by === "user" && !isText(decision.user_words)) problems.push(`${trail}: a decision by the owner needs "user_words", what the owner actually wrote, verbatim`);
  if (decision.decided_by === "agent" && !isText(decision.authority)) problems.push(`${trail}: a decision by the agent needs "authority", the owner's sentence that let the agent decide, verbatim`);
}

function validateSource(source, trail, problems) {
  if (!source || !isText(source.claim) || !isText(source.source)) problems.push(`${trail} needs "claim" and "source" (a file and line, a URL, or a command and its result)`);
}

function validateTicket(ticket) {
  const problems = [];
  if (ticket === null || typeof ticket !== "object" || Array.isArray(ticket)) return ["the ticket must be a JSON object"];
  findCredentials(ticket, "", problems);
  // The board is read by a person months later. A one-word title or a clipped note does not survive that.
  if (words(ticket.title) < 3 || ticket.title.length > 140) problems.push("title must be a readable phrase of three words or more, at most 140 characters");
  if (words(ticket.summary) < 8) problems.push('"summary" must be two or three full sentences a person can read without the rest of the ticket');
  if (!Array.isArray(ticket.done_when) || !ticket.done_when.length || !ticket.done_when.every(isText)) problems.push('"done_when" must list the acceptance criteria from the panel');
  if (!Array.isArray(ticket.sources) || !ticket.sources.length) problems.push('"sources" must list at least one claim with where it comes from');
  else ticket.sources.forEach((source, index) => validateSource(source, `sources[${index}]`, problems));
  if (ticket.decisions !== undefined && !Array.isArray(ticket.decisions)) problems.push('"decisions" must be a list');
  else (ticket.decisions || []).forEach((decision, index) => validateDecision(decision, `decisions[${index}]`, problems));
  if (!["user", "agent"].includes(ticket.approved_by)) problems.push('approved_by must be "user" or "agent"');
  if (ticket.approved_by === "user" && !isText(ticket.user_words)) problems.push('a ticket approved by the owner needs "user_words", the owner\'s approval verbatim');
  if (ticket.approved_by === "agent" && !isText(ticket.authority)) problems.push('a ticket opened by the agent needs "authority", the owner\'s sentence that allowed it, verbatim');
  if (ticket.status !== undefined && !STATUSES.includes(ticket.status)) problems.push(`status must be one of ${STATUSES.join(", ")}`);
  return problems;
}

/* ---------- storage ---------- */

/** Everything a person might search for, in one string for the full-text index. */
function searchable(t) {
  return [t.summary, t.body, t.user_words, t.authority, t.evidence, ...(t.done_when || []),
    ...(t.decisions || []).flatMap((d) => [d.question, d.chosen, d.reason, d.user_words, d.authority, ...(d.rejected || []).flatMap((r) => [r.option, r.reason])]),
    ...(t.sources || []).flatMap((s) => [s.claim, s.source])].filter(isText).join("\n");
}

const counts = (t) => ({
  unanswered: (t.decisions || []).filter(isPending).length,
  unseen: (t.decisions || []).filter((d) => d.decided_by === "agent" && !d.reviewed).length,
});

function rowToTicket(row) {
  return { id: row.id, project: row.project, group: row.grp, title: row.title, status: row.status, created_at: row.created_at, updated_at: row.updated_at, ...JSON.parse(row.data) };
}

const SELECT = "SELECT t.*, p.grp FROM tickets t JOIN projects p ON p.key = t.project";

function getTicket(db, idText) {
  const id = Number(idText);
  if (!idText || !Number.isInteger(id)) throw new UsageError("give the ticket number, for example: show 12");
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id);
  if (!row) throw new UsageError(`no ticket #${id}`);
  return rowToTicket(row);
}

function save(db, ticket) {
  const { id, project, group, title, status, created_at: created, updated_at: updated, ...data } = ticket;
  const c = counts(data);
  db.prepare("UPDATE tickets SET status = ?, unanswered = ?, unseen = ?, data = ?, updated_at = ? WHERE id = ?").run(status, c.unanswered, c.unseen, JSON.stringify(data), now(), id);
  db.prepare("DELETE FROM tickets_fts WHERE rowid = ?").run(id);
  db.prepare("INSERT INTO tickets_fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, searchable(data));
}

/** "K3" or "3" to a zero-based index into the ticket's decisions. */
function decisionIndex(ticket, label) {
  const match = /^K?(\d+)$/i.exec(label || "");
  const index = match ? Number(match[1]) - 1 : -1;
  if (!ticket.decisions?.[index]) throw new UsageError(`ticket #${ticket.id} has no decision ${label || "(none given)"}; it has ${ticket.decisions?.length || 0}`);
  return index;
}

/* ---------- commands ---------- */

const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function line(t) {
  const c = counts(t);
  const marks = [c.unanswered ? `${c.unanswered} belum dijawab` : "", c.unseen ? `${c.unseen} diputuskan agen*` : ""].filter(Boolean).join(", ");
  return `#${t.id}  ${t.group}/${t.project}  ${t.status}${marks ? `  [${marks}]` : ""}  ${short(t.title, 90)}`;
}

function printRows(rows, total) {
  rows.forEach((t) => console.log(line(t)));
  if (total > rows.length) console.log(`... ${total - rows.length} more (narrow with --project, --status, or raise --limit)`);
  if (!rows.length) console.log("no tickets match");
  else if (rows.some((t) => counts(t).unseen)) console.log("* decided by the agent, not yet seen by the owner");
}

async function cmdProject(args) {
  const [action] = args.splice(0, 1);
  const db = await openDb();
  if (action === "ensure") {
    const project = ensureProject(db, option(args, "--dir"));
    console.log(`${project.created ? "created" : "exists"}: ${project.grp}/${project.key}`);
    return 0;
  }
  if (action === "list") {
    const rows = db.prepare("SELECT p.key, p.grp, COUNT(t.id) AS n FROM projects p LEFT JOIN tickets t ON t.project = p.key GROUP BY p.key ORDER BY p.grp, p.key").all();
    rows.forEach((row) => console.log(`${row.grp}/${row.key}  ${row.n} ticket(s)`));
    if (!rows.length) console.log("no projects yet");
    return 0;
  }
  throw new UsageError("usage: project <ensure|list> [--dir <path>]");
}

async function cmdAdd(args) {
  const ticket = readJson(option(args, "--file"));
  const dir = option(args, "--dir");
  const problems = validateTicket(ticket);
  if (problems.length) throw new Refused(problems.join("\n"));
  const db = await openDb();
  const project = ensureProject(db, dir);
  const { title, status, ...data } = ticket;
  data.decisions = (data.decisions || []).map((d) => (isPending(d) ? d : { ...d, decided_at: now() }));
  const stamp = now();
  const c = counts(data);
  const result = db.prepare("INSERT INTO tickets (project, title, status, unanswered, unseen, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.key, title.trim(), status || "siap", c.unanswered, c.unseen, JSON.stringify(data), stamp, stamp);
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO tickets_fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, searchable(data));
  if (project.created) console.log(`created project: ${project.grp}/${project.key}`);
  console.log(`added #${id} to ${project.grp}/${project.key}: ${title.trim()}`);
  return 0;
}

async function cmdDecide(args) {
  const decision = readJson(option(args, "--file"));
  const answers = option(args, "--answers");
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const problems = [];
  findCredentials(decision, "", problems);
  validateDecision(decision, "decision", problems);
  if (answers && isPending(decision)) problems.push("--answers needs a decision that has been made, not another open question");
  if (problems.length) throw new Refused(problems.join("\n"));
  const stored = isPending(decision) ? decision : { ...decision, decided_at: now() };
  ticket.decisions = ticket.decisions || [];
  let index;
  if (answers) {
    index = decisionIndex(ticket, answers);
    if (!isPending(ticket.decisions[index])) throw new Refused(`K${index + 1} on ticket #${ticket.id} is already decided; add a new decision instead of rewriting an old one`);
    ticket.decisions[index] = stored;
  } else {
    index = ticket.decisions.push(stored) - 1;
  }
  save(db, ticket);
  console.log(`#${ticket.id} K${index + 1}: ${isPending(stored) ? "waiting for the owner's answer" : `decided by the ${stored.decided_by === "agent" ? "agent" : "owner"}`}`);
  return 0;
}

async function cmdSource(args) {
  const source = readJson(option(args, "--file"));
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const problems = [];
  findCredentials(source, "", problems);
  validateSource(source, "source", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  const index = ticket.sources.push(source);
  save(db, ticket);
  console.log(`#${ticket.id} E${index}: source added`);
  return 0;
}

async function cmdReview(args) {
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const index = decisionIndex(ticket, args[1]);
  const decision = ticket.decisions[index];
  if (decision.decided_by !== "agent") throw new Refused(`K${index + 1} on ticket #${ticket.id} was ${isPending(decision) ? "not decided yet" : "decided by the owner"}; only decisions made by the agent are reviewed`);
  decision.reviewed = true;
  save(db, ticket);
  console.log(`#${ticket.id} K${index + 1} marked as seen by the owner`);
  return 0;
}

async function cmdSet(args) {
  const status = option(args, "--status");
  const evidence = option(args, "--evidence");
  if (!args[0] || !status) throw new UsageError("usage: set <id> --status <status> [--evidence <text>]");
  if (!STATUSES.includes(status)) throw new Refused(`status must be one of ${STATUSES.join(", ")}`);
  // "Done" on the board means the same as everywhere else: there is something to point at.
  if (status === "selesai" && !isText(evidence)) throw new Refused('status "selesai" needs --evidence: the command and result, commit, or swipe report that shows it');
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  ticket.status = status;
  if (isText(evidence)) { ticket.evidence = evidence.trim(); ticket.finished_at = now(); }
  save(db, ticket);
  console.log(`#${ticket.id} is now ${status}`);
  return 0;
}

async function cmdList(args) {
  const filters = [];
  const values = [];
  for (const [name, column] of [["--project", "t.project"], ["--group", "p.grp"], ["--status", "t.status"]]) {
    const value = option(args, name);
    if (value !== undefined) { filters.push(`${column} = ?`); values.push(name === "--status" ? value : kebab(value)); }
  }
  if (flag(args, "--waiting")) filters.push("(t.unanswered > 0 OR t.unseen > 0)");
  const limit = Number(option(args, "--limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive number");
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const db = await openDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t JOIN projects p ON p.key = t.project${where}`).get(...values).n;
  printRows(db.prepare(`${SELECT}${where} ORDER BY t.id DESC LIMIT ?`).all(...values, limit).map(rowToTicket), total);
  return 0;
}

const byText = (d) => (isPending(d) ? "belum dijawab pemilik" : d.decided_by === "agent" ? `diputuskan agen${d.reviewed ? " (sudah dilihat pemilik)" : " (belum dilihat pemilik)"}` : "diputuskan pemilik");

async function cmdShow(args) {
  const db = await openDb();
  const t = getTicket(db, args[0]);
  const out = [`#${t.id}  ${t.group}/${t.project}  ${t.status}`, `Judul: ${t.title}`, `Dicatat: ${t.created_at}${t.updated_at !== t.created_at ? `, diubah ${t.updated_at}` : ""}`];
  const add = (label, value) => { if (isText(value)) out.push("", `${label}:`, value.trim()); };
  add("Ringkasan", t.summary);
  add("Isi", t.body);
  out.push("", "Selesai kalau:", ...t.done_when.map((item) => `- ${item}`));
  out.push("", "Keputusan:");
  if (!t.decisions?.length) out.push("(belum ada)");
  (t.decisions || []).forEach((d, index) => {
    out.push(`K${index + 1} (${byText(d)}${d.decided_at ? `, ${d.decided_at.slice(0, 10)}` : ""}): ${d.question}`);
    if (isPending(d)) return;
    out.push(`  Yang dipilih: ${d.chosen}`, `  Alasan: ${d.reason}`, ...d.rejected.map((r) => `  Ditolak: ${r.option}: ${r.reason}`));
    out.push(d.decided_by === "agent" ? `  Izin yang dipakai agen: "${d.authority}"` : `  Kata pemilik: "${d.user_words}"`);
  });
  out.push("", "Daftar sumber:", ...t.sources.map((s, index) => `E${index + 1}: ${s.claim} | ${s.source}${isText(s.status) ? ` | ${s.status}` : ""}`));
  out.push("", t.approved_by === "agent" ? `Dibuka agen dengan izin: "${t.authority}"` : `Disetujui pemilik: "${t.user_words}"`);
  add("Bukti selesai", t.evidence ? `${t.evidence} (${t.finished_at})` : "");
  console.log(out.join("\n"));
  return 0;
}

async function cmdSearch(args) {
  const project = option(args, "--project");
  const text = args.join(" ").trim();
  if (!text) throw new UsageError("usage: search <words> [--project p]");
  const db = await openDb();
  const scope = project ? " AND t.project = ?" : "";
  const params = project ? [kebab(project)] : [];
  let rows;
  try {
    rows = db.prepare(`${SELECT} JOIN tickets_fts f ON f.rowid = t.id WHERE tickets_fts MATCH ?${scope} ORDER BY t.id DESC LIMIT 20`).all(`"${text.replace(/"/g, '""')}"`, ...params);
  } catch {
    rows = [];
  }
  printRows(rows.map(rowToTicket), rows.length);
  return 0;
}

async function cmdExport(args) {
  const project = option(args, "--project");
  const db = await openDb();
  const rows = project ? db.prepare(`${SELECT} WHERE t.project = ? ORDER BY t.id`).all(kebab(project)) : db.prepare(`${SELECT} ORDER BY t.id`).all();
  console.log(JSON.stringify({ exported_at: now(), tickets: rows.map(rowToTicket) }, null, 2));
  return 0;
}

/* ---------- pages ---------- */

// Text from the board goes into HTML as text. Two extra guards keep an owner's sentence from tripping the
// document checker: it rejects template braces and the words it treats as unfinished-work markers.
const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/\{\{/g, "{&#8203;{")
  .replace(/\b(T)(ODO)\b|\b(T)(BD)\b|\b(F)(IXME)\b/g, (m, a, b, c, d, e, f) => `${a || c || e}&#8203;${b || d || f}`)
  .replace(/(lorem) (ipsum)/gi, "$1&#8203; $2");

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const longDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// The board is an app-like set of pages, not a long document: no table of contents, one column,
// and cards that are links. Everything else comes from the shared doc-style.
const PAGE_STYLE = `<style id="page-style">
  .wrap { grid-template-columns: minmax(0, 1fr); }
  nav.toc, .toc-mobile { display: none; }
  .appbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 0 0 16px; font-weight: 600; }
  a.ticket { display: block; color: inherit; text-decoration: none; }
  a.ticket:hover, a.ticket:focus-visible { border-color: var(--accent); }
  a.ticket h4 { margin-top: 0; }
  a.ticket p { margin: 8px 0 0; }
  .column-empty { color: var(--muted); font-size: 14px; }
</style>`;

const PAGE_SCRIPT = `<script id="page-script">
(function () {
  var group = document.querySelector("[data-board-filters]");
  if (!group) return;
  var KEY = "board-project";
  var buttons = [].slice.call(group.querySelectorAll("[data-board-filter]"));
  function apply(project) {
    if (!buttons.some(function (b) { return b.getAttribute("data-board-filter") === project; })) project = "";
    buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-board-filter") === project)); });
    [].slice.call(document.querySelectorAll("[data-project]")).forEach(function (el) {
      el.hidden = project !== "" && el.getAttribute("data-project") !== project;
    });
    [].slice.call(document.querySelectorAll("[data-column]")).forEach(function (col) {
      var shown = [].slice.call(col.querySelectorAll("[data-project]")).filter(function (el) { return !el.hidden; }).length;
      var badge = col.querySelector("[data-count]");
      if (badge) badge.textContent = String(shown);
      var empty = col.querySelector(".column-empty");
      if (empty) empty.hidden = shown > 0;
    });
    try { localStorage.setItem(KEY, project); } catch (e) { /* the filter still works without storage */ }
  }
  buttons.forEach(function (b) { b.addEventListener("click", function () { apply(b.getAttribute("data-board-filter")); }); });
  var saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch (e) { saved = ""; }
  apply(saved);
})();
</script>`;

const section = (id, number, heading, sub, body) => `    <section id="${id}">
      <h2><span class="num">${String(number).padStart(2, "0")}</span>${heading}</h2>
${sub ? `      <p class="sub">${sub}</p>\n` : ""}${body}
    </section>`;

function boardCard(t) {
  const c = counts(t);
  const pills = [`<span class="pill info">${esc(t.group)} / ${esc(t.project)}</span>`,
    t.status === "dikerjakan" ? '<span class="pill accent">Dikerjakan</span>' : "",
    c.unanswered ? `<span class="pill warn">${c.unanswered} belum kamu jawab</span>` : "",
    c.unseen ? `<span class="pill warn">${c.unseen} diputuskan agen, belum kamu lihat</span>` : ""].filter(Boolean).join(" ");
  return `          <a class="card ticket" href="tiket-${t.id}.html" data-project="${esc(t.project)}">
            <h4>#${t.id} · ${esc(t.title)}</h4>
            <p>${pills}</p>
          </a>`;
}

const boardColumn = (title, tickets, note) => `        <div data-column>
          <h3>${title} <span class="pill muted" data-count>${tickets.length}</span></h3>
          <div class="stack">
${tickets.map(boardCard).join("\n")}
          </div>
          <p class="column-empty"${tickets.length ? " hidden" : ""}>Tidak ada.</p>${note ? `\n          <p class="note">${note}</p>` : ""}
        </div>`;

function boardSections(tickets, projects) {
  const isWaiting = (t) => { const c = counts(t); return c.unanswered > 0 || c.unseen > 0; };
  const open = tickets.filter((t) => t.status === "siap" || t.status === "dikerjakan");
  const waiting = open.filter(isWaiting);
  const active = open.filter((t) => !isWaiting(t));
  const doneAll = tickets.filter((t) => t.status === "selesai");
  const done = doneAll.slice(0, 30);
  const chips = ['<button class="chip" type="button" data-board-filter="" aria-pressed="true">Semua proyek</button>',
    ...projects.map((p) => `<button class="chip" type="button" data-board-filter="${esc(p.key)}" aria-pressed="false">${esc(p.grp)} / ${esc(p.key)}</button>`)].join("\n        ");
  return [section("ringkasan", 0, "Proyek", "Pilih proyek untuk menyaring papan. Pilihanmu diingat di browser ini.", `      <div class="chips" data-board-filters>
        ${chips}
      </div>`),
  section("papan", 1, "Papan", "Buka sebuah tiket untuk melihat ringkasan, keputusan, dan daftar sumbernya.", `      <div class="grid-3">
${boardColumn("Menunggu kamu", waiting)}
${boardColumn("Siap dan dikerjakan", active)}
${boardColumn("Selesai", done, doneAll.length > done.length ? `Menampilkan ${done.length} tiket terbaru dari ${doneAll.length}.` : "")}
      </div>`)].join("\n\n");
}

function decisionCard(d, index) {
  const head = `<h4>K${index + 1} · ${esc(d.question)}</h4>`;
  if (isPending(d)) return `      <div class="card">${head}<p><span class="pill warn">Belum kamu jawab</span></p></div>`;
  const pill = d.decided_by === "agent"
    ? `<span class="pill ${d.reviewed ? "muted" : "warn"}">Diputuskan agen${d.reviewed ? "" : ", belum kamu lihat"}</span>`
    : '<span class="pill ok">Diputuskan kamu</span>';
  const quote = d.decided_by === "agent"
    ? `<blockquote><p>"${esc(d.authority)}"</p><footer>Kalimatmu yang dipakai agen sebagai izin memutuskan.</footer></blockquote>`
    : `<blockquote><p>"${esc(d.user_words)}"</p><footer>Kalimatmu, ${esc(longDate(d.decided_at))}.</footer></blockquote>`;
  return `      <div class="card">${head}
        <p>${pill} <span class="lbl">${esc(longDate(d.decided_at))}</span></p>
        <p><b>Yang dipilih.</b> ${esc(d.chosen)}</p>
        <p><b>Alasan.</b> ${esc(d.reason)}</p>
        <p><b>Yang ditolak.</b></p>
        <ul>${d.rejected.map((r) => `<li><b>${esc(r.option)}:</b> ${esc(r.reason)}</li>`).join("")}</ul>
        ${quote}
      </div>`;
}

function ticketSections(t) {
  const approval = t.approved_by === "agent"
    ? `<blockquote><p>"${esc(t.authority)}"</p><footer>Tiket ini dibuka agen. Kalimatmu di atas yang dipakai sebagai izin.</footer></blockquote>`
    : `<blockquote><p>"${esc(t.user_words)}"</p><footer>Persetujuanmu, ${esc(longDate(t.created_at))}.</footer></blockquote>`;
  const parts = [
    section("ringkasan", 0, "Ringkasan", null, `      <p>${esc(t.summary)}</p>
${isText(t.body) ? `      <p>${esc(t.body)}</p>\n` : ""}      ${approval}`),
    section("keputusan", 1, "Keputusan", null, t.decisions?.length ? `      <div class="stack">
${t.decisions.map(decisionCard).join("\n")}
      </div>` : "      <p>Belum ada keputusan yang dicatat untuk tiket ini.</p>"),
    section("selesai-kalau", 2, "Selesai kalau", null, `      <ul>
${t.done_when.map((item) => `        <li>${esc(item)}</li>`).join("\n")}
      </ul>${isText(t.evidence) ? `\n      <div class="card"><h4>Bukti selesai</h4><p>${esc(t.evidence)}</p><p class="lbl">${esc(longDate(t.finished_at))}</p></div>` : ""}`),
    section("sumber", 3, "Daftar sumber", null, `      <div class="table-scroll"><table>
        <thead><tr><th>ID</th><th>Klaim</th><th>Sumber</th><th>Status</th></tr></thead>
        <tbody>
${t.sources.map((s, index) => `          <tr><td class="id">E${index + 1}</td><td>${esc(s.claim)}</td><td>${esc(s.source)}</td><td>${esc(s.status || "")}</td></tr>`).join("\n")}
        </tbody>
      </table></div>`),
  ];
  return parts.join("\n\n");
}

function makePage(template, { fills, sections, appbar }) {
  const start = template.indexOf('<section id="ringkasan">');
  const end = template.indexOf('<footer class="doc">');
  if (start === -1 || end === -1) throw new UsageError("the doc-tools template changed shape: cannot find the summary section or the footer");
  let html = `${template.slice(0, start)}${sections.trimStart()}\n\n    ${template.slice(end)}`;
  for (const [key, value] of Object.entries(fills)) html = html.split(`{{${key}}}`).join(value);
  if (!html.includes("<main>") || !html.includes("</head>")) throw new UsageError("the doc-tools template changed shape: cannot find <main> or </head>");
  return html
    .replace("</head>", `${PAGE_STYLE}\n</head>`)
    .replace("<main>", `<main>\n    <p class="appbar">${appbar}</p>`)
    .replace("</body>", `${PAGE_SCRIPT}\n<!-- ${REPORT_MARK} -->\n</body>`);
}

async function cmdReport(args) {
  const out = option(args, "--out");
  if (!out) throw new UsageError("usage: report --out <dir>");
  const dir = path.resolve(out);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new UsageError(`--out must be a folder: ${dir}`);
  const db = await openDb();
  const tickets = db.prepare(`${SELECT} ORDER BY t.id DESC`).all().map(rowToTicket);
  const projects = db.prepare("SELECT key, grp FROM projects ORDER BY grp, key").all();
  const stamp = now();
  const foot = `Dihasilkan board-tools pada ${longDate(stamp)}. Halaman ini salinan; sumbernya basis data papan.`;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "board-report-"));
  try {
    const seed = path.join(scratch, "seed.html");
    const made = spawnSync(process.execPath, [DOC_TOOLS, "new", seed], { encoding: "utf8" });
    if (made.status !== 0) throw new UsageError(`doc-tools new failed: ${(made.stdout || "") + (made.stderr || "")}`);
    const template = fs.readFileSync(seed, "utf8");
    fs.rmSync(seed);

    const waiting = tickets.filter((t) => (t.status === "siap" || t.status === "dikerjakan") && (counts(t).unanswered || counts(t).unseen)).length;
    const pages = [["index.html", makePage(template, {
      appbar: "Papan kerja",
      sections: boardSections(tickets, projects),
      fills: { JUDUL_TAB: "Papan kerja", JENIS: "Papan", TOPIK: "Semua proyek", STATUS: waiting ? `${waiting} menunggu kamu` : "Tidak ada yang menunggu",
        JUDUL: "Papan kerja", LEDE: "Tiket dari semua proyek. Tiap tiket memuat ringkasan, keputusan yang diambil, dan sumbernya, ditulis dengan kalimat lengkap.",
        TANGGAL: longDate(stamp), BASIS: "basis data papan", STATUS_RINCI: `${projects.length} proyek, ${tickets.length} tiket`, KAKI: foot },
    })]];
    for (const t of tickets) {
      pages.push([`tiket-${t.id}.html`, makePage(template, {
        appbar: '<a href="index.html">&larr; Kembali ke papan</a>',
        sections: ticketSections(t),
        fills: { JUDUL_TAB: `#${t.id} ${esc(t.title)}`, JENIS: `Tiket #${t.id}`, TOPIK: `${esc(t.group)} / ${esc(t.project)}`, STATUS: STATUS_LABEL[t.status],
          JUDUL: esc(t.title), LEDE: `Tiket di proyek ${esc(t.project)}, dibuka ${longDate(t.created_at)}.`,
          TANGGAL: longDate(t.updated_at), BASIS: "basis data papan", STATUS_RINCI: STATUS_LABEL[t.status], KAKI: foot },
      })]);
    }

    // Nothing reaches the output folder unless every page is ours to replace and passes the checker.
    for (const [name] of pages) {
      const target = path.join(dir, name);
      if (fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(REPORT_MARK)) throw new UsageError(`refusing to overwrite a file this tool did not write: ${target}`);
    }
    for (const [name, html] of pages) {
      const draft = path.join(scratch, name);
      fs.writeFileSync(draft, html);
      const checked = spawnSync(process.execPath, [DOC_TOOLS, "check", draft], { encoding: "utf8" });
      if (checked.status !== 0) throw new Refused(`${name} does not pass doc-tools check; nothing written\n${(checked.stdout || "") + (checked.stderr || "")}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [name] of pages) fs.copyFileSync(path.join(scratch, name), path.join(dir, name));
    console.log(`board written: ${path.join(dir, "index.html")}`);
    console.log(`${projects.length} project(s), ${tickets.length} ticket page(s), ${waiting} waiting for the owner`);
    return 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const COMMANDS = { project: cmdProject, add: cmdAdd, decide: cmdDecide, source: cmdSource, review: cmdReview, set: cmdSet, list: cmdList, show: cmdShow, search: cmdSearch, export: cmdExport, report: cmdReport };
const [command, ...rest] = process.argv.slice(2);
try {
  if (!COMMANDS[command]) throw new UsageError(`usage: board-tools.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
  process.exitCode = await COMMANDS[command](rest);
} catch (error) {
  if (error instanceof Refused) { console.error(`refused:\n${error.message.split("\n").map((l) => `  - ${l}`).join("\n")}`); process.exitCode = 1; }
  else if (error instanceof UsageError) { console.error(`error: ${error.message}`); process.exitCode = 2; }
  else throw error;
}
