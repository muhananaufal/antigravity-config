#!/usr/bin/env node
// board-tools: one ticket board for every project, kept in a single SQLite file outside all repos.
//
// A ticket belongs to one project and is the only container: its summary, acceptance criteria,
// decisions, sources and history all live inside it. A decision never exists without its ticket.
//
//   node board-tools.mjs project ensure [--dir <path>]     create the project for a folder if it is not on the board yet
//   node board-tools.mjs project list
//   node board-tools.mjs add --file <ticket.json> [--dir <path>]
//   node board-tools.mjs approve <id> --file <approval.json>  an idea becomes agreed work
//   node board-tools.mjs decide <id> --file <decision.json> [--answers K<n>]
//   node board-tools.mjs source <id> --file <source.json>
//   node board-tools.mjs unverified <id> --file <guess.json>  a claim that is still a guess, with how to check it
//   node board-tools.mjs verify <id> U<n> --result <text>   the guess was checked; what was found
//   node board-tools.mjs link <id> --label <text> --target <path or URL>
//   node board-tools.mjs review <id> K<n>                   the owner has seen a decision the agent made
//   node board-tools.mjs note <id> --text <text>            where the work stands and what comes next
//   node board-tools.mjs merged <id> --into <branch>        the work is on that branch; checked against git
//   node board-tools.mjs hook <install|remove> [--dir <path>] [--existing chain|replace|skip]   the commit guard and the push guard
//   node board-tools.mjs project protect [--dir <path>] [--branches a,b,c | --default]        branches the push guard refuses
//   node board-tools.mjs set <id> --status <status> [--evidence <text>] [--reason <text>] [--words <owner's sentence>]
//   node board-tools.mjs list [--project p] [--group g] [--status s] [--waiting] [--limit n]
//                             [--created-from d] [--created-to d] [--updated-from d] [--updated-to d]
//   node board-tools.mjs show <id>                          the full text of one ticket
//   node board-tools.mjs search <words> [--project p]       ticket numbers and titles only
//   node board-tools.mjs export [--project p]               JSON
//   node board-tools.mjs report [--out <dir>] [--all]       rebuild the pages by hand; every write command already does it
//
// The board lives at ~/.aetheris/board/board.db; AETHERIS_BOARD overrides the path.
// Reading is deliberately narrow: `list` and `search` print one short line per ticket, and only `show`
// prints the long text, so an agent never loads the whole board to answer one question.
// The tool and its pages speak English; what the owner and the agent wrote is stored and shown as written.
// Exit codes: 0 ok, 1 the data was refused, 2 usage or environment error.
// No dependencies; needs a Node version with the built-in node:sqlite module.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_TOOLS = path.join(HERE, "..", "..", "meta-prd", "scripts", "doc-tools.mjs");
const DB_PATH = process.env.AETHERIS_BOARD || path.join(os.homedir(), ".aetheris", "board", "board.db");
// The pages are kept in a "site" folder beside the board file. A test board therefore writes its pages
// beside itself and never into the owner's real ones.
const SITE_DIR = path.join(path.dirname(DB_PATH), "site");
const WATCH_INTERVAL_MS = 3000;

// idea: recorded, not approved yet. review: the agent is done and attached evidence, the owner has not accepted it.
const STATUSES = ["idea", "ready", "doing", "review", "done", "cancelled"];
const STATUS_LABEL = { idea: "Idea", ready: "Ready", doing: "In progress", review: "Needs your check", done: "Done", cancelled: "Cancelled" };
// Board columns in order. "waiting" is not a status: it holds open tickets with a question for the owner.
const COLUMNS = [["idea", "Idea"], ["waiting", "Waiting for you"], ["ready", "Ready"], ["doing", "In progress"], ["review", "Needs your check"], ["done", "Done"], ["cancelled", "Cancelled"]];
// Cards a column shows before "Show more". Every ticket is still written to the page, so search and the date range reach all of them.
const PAGE_SIZE = 10;
// Work branches follow meta-git: the prefix is the ticket's type. A folder without git has no branch,
// so its tickets state the type, and may also be docs or chore.
const BRANCH_TYPES = ["feature", "fix", "refactor", "hotfix", "release"];
const TYPES = [...BRANCH_TYPES, "docs", "chore"];
const BRANCH_RULE = new RegExp(`^(${BRANCH_TYPES.join("|")})/[a-z0-9][a-z0-9._-]*$`);
const BRANCH_HINT = `${BRANCH_TYPES.map((t) => `${t}/`).join(", ")} followed by lowercase letters, digits, dots or dashes`;
// Integration branches carry no ticket of their own, so the commit guard leaves them alone.
const UNGUARDED = ["main", "master", "develop", "staging", "HEAD"];
// Integration branches the push guard refuses a direct push to, unless a project sets its own list.
const PROTECTED = ["main", "master", "develop", "staging"];
const GUARD_MARK = "board-tools commit guard";
const CHAINED = "pre-commit.before-board";
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
      follows INTEGER REFERENCES tickets(id),
      branch TEXT, type TEXT,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tickets_project ON tickets(project, status);
    CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(title, body);
  `);
  // Columns added after the first boards were created are added here, so an older board file keeps working.
  const columns = db.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
  if (!columns.includes("protected")) db.exec("ALTER TABLE projects ADD COLUMN protected TEXT");
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

/** Runs git in a folder. Never throws: a missing git or a failing command is `ok: false`. */
function git(dir, args) {
  const out = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: out.status === 0, out: (out.stdout || "").trim(), err: (out.stderr || "").trim() };
}

const isRepo = (dir) => fs.existsSync(dir) && git(dir, ["rev-parse", "--is-inside-work-tree"]).out === "true";

/** A project is named after its folder and grouped by the folder above it. */
function projectOf(dir) {
  const full = path.resolve(dir || process.cwd());
  const key = kebab(path.basename(full));
  if (!key) throw new UsageError(`cannot name a project from the folder ${full}`);
  return { key, grp: kebab(path.basename(path.dirname(full))) || "other", dir: full };
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

/** The type and branch of agreed work. In a git repository the branch decides the type; elsewhere the type is stated. */
function validateKind(ticket, repo, problems) {
  if (ticket.tags !== undefined) problems.push('free-form "tags" are not used; the only label is the type, taken from the branch');
  if (ticket.type !== undefined && !TYPES.includes(ticket.type)) { problems.push(`type must be one of ${TYPES.join(", ")}`); return; }
  if (!repo) {
    if (ticket.branch !== undefined) problems.push("this project folder is not a git repository, so its tickets have no branch; state the type instead");
    else if (ticket.type === undefined) problems.push(`a ticket in a folder without git needs "type": one of ${TYPES.join(", ")}`);
    return;
  }
  if (!isText(ticket.branch)) { problems.push(`a ticket in a git repository needs "branch": the work branch agreed for it (${BRANCH_HINT})`); return; }
  if (!BRANCH_RULE.test(ticket.branch)) { problems.push(`branch "${ticket.branch}" does not follow the naming rule: ${BRANCH_HINT}`); return; }
  const fromBranch = ticket.branch.split("/")[0];
  if (ticket.type !== undefined && ticket.type !== fromBranch) problems.push(`type "${ticket.type}" disagrees with branch "${ticket.branch}", which makes this a ${fromBranch} ticket; leave "type" out and it is taken from the branch`);
}

function validateTicket(ticket, { repo = false } = {}) {
  const problems = [];
  if (ticket === null || typeof ticket !== "object" || Array.isArray(ticket)) return ["the ticket must be a JSON object"];
  findCredentials(ticket, "", problems);
  // The board is read by a person months later. A one-word title or a clipped note does not survive that.
  if (words(ticket.title) < 3 || ticket.title.length > 140) problems.push("title must be a readable phrase of three words or more, at most 140 characters");
  if (words(ticket.summary) < 8) problems.push('"summary" must be two or three full sentences a person can read without the rest of the ticket');
  if (ticket.status !== undefined && !STATUSES.includes(ticket.status)) { problems.push(`status must be one of ${STATUSES.join(", ")}`); return problems; }
  if (ticket.decisions !== undefined && !Array.isArray(ticket.decisions)) problems.push('"decisions" must be a list');
  else (ticket.decisions || []).forEach((decision, index) => validateDecision(decision, `decisions[${index}]`, problems));
  if (ticket.follows !== undefined && !Number.isInteger(ticket.follows)) problems.push('"follows" must be the number of the ticket this one continues');
  validateExtras(ticket, problems);
  // An idea is only a title and a summary. The rest is required once it becomes agreed work.
  if (ticket.status === "idea") {
    if (ticket.approved_by !== undefined) problems.push('an idea has no "approved_by" yet; use "approve" when the owner agrees to it');
    return problems;
  }
  if (!Array.isArray(ticket.done_when) || !ticket.done_when.length || !ticket.done_when.every(isText)) problems.push('"done_when" must list the acceptance criteria from the panel');
  if (!Array.isArray(ticket.sources) || !ticket.sources.length) problems.push('"sources" must list at least one claim with where it comes from');
  else ticket.sources.forEach((source, index) => validateSource(source, `sources[${index}]`, problems));
  if (!["user", "agent"].includes(ticket.approved_by)) problems.push('approved_by must be "user" or "agent"');
  if (ticket.approved_by === "user" && !isText(ticket.user_words)) problems.push('a ticket approved by the owner needs "user_words", the owner\'s approval verbatim');
  if (ticket.approved_by === "agent" && !isText(ticket.authority)) problems.push('a ticket opened by the agent needs "authority", the owner\'s sentence that allowed it, verbatim');
  if (["review", "done", "cancelled"].includes(ticket.status)) problems.push(`a new ticket starts as idea, ready or doing; "${ticket.status}" is reached with "set"`);
  validateKind(ticket, repo, problems);
  return problems;
}

/* ---------- storage ---------- */

/** Everything a person might search for, in one string for the full-text index. */
function searchable(t) {
  return [t.summary, t.body, t.user_words, t.authority, t.evidence, ...(t.done_when || []),
    ...(t.decisions || []).flatMap((d) => [d.question, d.chosen, d.reason, d.user_words, d.authority, ...(d.rejected || []).flatMap((r) => [r.option, r.reason])]),
    ...(t.sources || []).flatMap((s) => [s.claim, s.source]), ...(t.out_of_scope || []),
    ...(t.unverified || []).flatMap((u) => [u.claim, u.check, u.result]), ...(t.links || []).flatMap((l) => [l.label, l.target])].filter(isText).join("\n");
}

const counts = (t) => ({
  unanswered: (t.decisions || []).filter(isPending).length,
  unseen: (t.decisions || []).filter((d) => d.decided_by === "agent" && !d.reviewed).length,
  returned: (t.history || []).filter((h) => h.returned).length,
  unverified: (t.unverified || []).filter((u) => !isText(u.result)).length,
});

/**
 * Three optional parts of a ticket, each a plain list:
 * out_of_scope - what was deliberately left out, so nobody later wonders why it is missing;
 * unverified   - claims that were still guesses when the work was agreed, each with the way to check it;
 * links        - the documents made for this work (PRD, handover, swipe report, pull request).
 */
function validateExtras(ticket, problems) {
  if (ticket.out_of_scope !== undefined && (!Array.isArray(ticket.out_of_scope) || !ticket.out_of_scope.every(isText))) problems.push('"out_of_scope" must be a list of full sentences, each naming one thing that is deliberately not done');
  if (ticket.unverified !== undefined && !Array.isArray(ticket.unverified)) problems.push('"unverified" must be a list');
  else (ticket.unverified || []).forEach((item, index) => validateGuess(item, `unverified[${index}]`, problems));
  if (ticket.links !== undefined && !Array.isArray(ticket.links)) problems.push('"links" must be a list');
  else (ticket.links || []).forEach((item, index) => validateLink(item, `links[${index}]`, problems));
}

function validateGuess(item, trail, problems) {
  if (!item || !isText(item.claim) || !isText(item.check)) problems.push(`${trail} needs "claim" (what is still a guess) and "check" (the cheapest way to find out)`);
}

function validateLink(item, trail, problems) {
  if (!item || !isText(item.label) || !isText(item.target)) problems.push(`${trail} needs "label" (what the document is) and "target" (its path or URL)`);
}

/** The board column a ticket sits in. Anything that needs the owner wins over the plain status. */
function columnOf(t) {
  if (t.status === "done" || t.status === "cancelled") return t.status;
  const c = counts(t);
  if (c.unanswered) return "waiting";
  if (t.status === "review" || c.unseen) return "review";
  return t.status;
}

function rowToTicket(row) {
  return { id: row.id, project: row.project, group: row.grp, dir: row.dir, title: row.title, status: row.status, created_at: row.created_at, updated_at: row.updated_at, ...JSON.parse(row.data) };
}

const SELECT = "SELECT t.*, p.grp, p.dir FROM tickets t JOIN projects p ON p.key = t.project";

/** Another open ticket of the project on the same branch, if any: without a number in the branch name they could not be told apart. */
function branchTwin(db, project, branch, exceptId) {
  if (!branch) return null;
  return db.prepare("SELECT id FROM tickets WHERE project = ? AND branch = ? AND status NOT IN ('done', 'cancelled') AND id != ?").get(project, branch, exceptId ?? 0) || null;
}

function getTicket(db, idText) {
  const id = Number(idText);
  if (!idText || !Number.isInteger(id)) throw new UsageError("give the ticket number, for example: show 12");
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id);
  if (!row) throw new UsageError(`no ticket #${id}`);
  return rowToTicket(row);
}

function save(db, ticket) {
  const { id, project, group, dir, title, status, created_at: created, updated_at: updated, ...data } = ticket;
  const c = counts(data);
  db.prepare("UPDATE tickets SET status = ?, unanswered = ?, unseen = ?, branch = ?, type = ?, data = ?, updated_at = ? WHERE id = ?")
    .run(status, c.unanswered, c.unseen, data.branch ?? null, data.type ?? null, JSON.stringify(data), now(), id);
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
  const marks = [c.unanswered ? `${c.unanswered} unanswered` : "", c.unseen ? `${c.unseen} agent decision*` : "", c.unverified ? `${c.unverified} unverified` : "", c.returned ? `sent back ${c.returned}x` : ""].filter(Boolean).join(", ");
  return `#${t.id}  ${t.group}/${t.project}  ${t.status}${marks ? `  [${marks}]` : ""}  ${short(t.title, 90)}`;
}

function printRows(rows, total) {
  rows.forEach((t) => console.log(line(t)));
  if (total > rows.length) console.log(`... ${total - rows.length} more (narrow with --project, --status, a date range, or raise --limit)`);
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
  if (action === "protect") {
    // Which branches of this project the push guard refuses. Most projects use the standard list;
    // one whose staging or production branch has another name gets its own.
    const branches = option(args, "--branches");
    const standard = flag(args, "--default");
    const project = ensureProject(db, option(args, "--dir"));
    if (branches !== undefined) {
      const list = branches.split(",").map((name) => name.trim()).filter(Boolean);
      const bad = list.filter((name) => !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes(".."));
      if (!list.length || bad.length) throw new Refused(`not a usable branch name: ${bad.join(", ") || "(empty list)"}; give the names separated by commas, for example: main, uat, prod`);
      db.prepare("UPDATE projects SET protected = ? WHERE key = ?").run([...new Set(list)].join(","), project.key);
    } else if (standard) {
      db.prepare("UPDATE projects SET protected = NULL WHERE key = ?").run(project.key);
    }
    const row = db.prepare("SELECT protected FROM projects WHERE key = ?").get(project.key);
    const own = isText(row.protected);
    console.log(`${project.grp}/${project.key} protects: ${(own ? row.protected.split(",") : PROTECTED).join(", ")}${own ? "" : " (the default list)"}`);
    return 0;
  }
  throw new UsageError("usage: project <ensure|list|protect> [--dir <path>] [--branches a,b,c | --default]");
}

async function cmdAdd(args) {
  const ticket = readJson(option(args, "--file"));
  const dir = option(args, "--dir");
  const problems = validateTicket(ticket, { repo: isRepo(projectOf(dir).dir) });
  if (problems.length) throw new Refused(problems.join("\n"));
  const db = await openDb();
  const project = ensureProject(db, dir);
  const { title, status = "ready", ...data } = ticket;
  if (data.branch) data.type = data.branch.split("/")[0];
  const twin = branchTwin(db, project.key, data.branch);
  if (twin) throw new Refused(`ticket #${twin.id} is already open on the same branch (${data.branch}); one branch carries one open ticket, so finish that one or agree on another branch`);
  if (data.follows !== undefined) {
    const earlier = db.prepare("SELECT project FROM tickets WHERE id = ?").get(data.follows);
    if (!earlier) throw new Refused(`"follows" points at ticket #${data.follows}, which does not exist`);
    if (earlier.project !== project.key) throw new Refused(`"follows" points at ticket #${data.follows} in another project (${earlier.project}); a ticket continues work in its own project`);
  }
  const stamp = now();
  data.decisions = (data.decisions || []).map((d) => (isPending(d) ? d : { ...d, decided_at: stamp }));
  data.history = [{ at: stamp, to: status }];
  const c = counts(data);
  const result = db.prepare("INSERT INTO tickets (project, title, status, unanswered, unseen, follows, branch, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.key, title.trim(), status, c.unanswered, c.unseen, data.follows ?? null, data.branch ?? null, data.type ?? null, JSON.stringify(data), stamp, stamp);
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO tickets_fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, searchable(data));
  if (project.created) console.log(`created project: ${project.grp}/${project.key}`);
  console.log(`added #${id} to ${project.grp}/${project.key}: ${title.trim()}`);
  return 0;
}

/** An idea becomes agreed work: the criteria, sources and the owner's approval are added in one step. */
async function cmdApprove(args) {
  const patch = readJson(option(args, "--file"));
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  if (ticket.status !== "idea") throw new Refused(`#${ticket.id} is "${ticket.status}", not an idea; only an idea is approved`);
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new Refused("the approval must be a JSON object");
  const stamp = now();
  const { decisions: added = [], title, status, ...fields } = patch;
  const merged = { ...ticket, ...fields, status: "ready", decisions: [...(ticket.decisions || []), ...(Array.isArray(added) ? added : [])] };
  const problems = validateTicket(merged, { repo: isRepo(ticket.dir) });
  if (problems.length) throw new Refused(problems.join("\n"));
  if (merged.branch) merged.type = merged.branch.split("/")[0];
  const twin = branchTwin(db, ticket.project, merged.branch, ticket.id);
  if (twin) throw new Refused(`ticket #${twin.id} is already open on the same branch (${merged.branch}); one branch carries one open ticket`);
  merged.decisions = merged.decisions.map((d) => (isPending(d) || d.decided_at ? d : { ...d, decided_at: stamp }));
  merged.history = [...(ticket.history || []), { at: stamp, from: "idea", to: "ready", words: merged.approved_by === "user" ? merged.user_words : merged.authority }];
  save(db, merged);
  console.log(`#${ticket.id} approved: now ready`);
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
  ticket.sources = ticket.sources || [];
  const index = ticket.sources.push(source);
  save(db, ticket);
  console.log(`#${ticket.id} E${index}: source added`);
  return 0;
}

/** A claim found to be a guess while the work is under way. */
async function cmdUnverified(args) {
  const item = readJson(option(args, "--file"));
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const problems = [];
  findCredentials(item, "", problems);
  validateGuess(item, "the entry", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  ticket.unverified = ticket.unverified || [];
  const index = ticket.unverified.push({ claim: item.claim, check: item.check });
  save(db, ticket);
  console.log(`#${ticket.id} U${index}: recorded as not yet verified`);
  return 0;
}

/** The guess has been checked: what was found is written next to it. A result is recorded once, like a decision. */
async function cmdVerify(args) {
  const result = option(args, "--result");
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const match = /^U?(\d+)$/i.exec(args[1] || "");
  const item = match ? ticket.unverified?.[Number(match[1]) - 1] : undefined;
  if (!item) throw new UsageError(`ticket #${ticket.id} has no entry ${args[1] || "(none given)"} under "not yet verified"; it has ${ticket.unverified?.length || 0}`);
  if (isText(item.result)) throw new Refused(`U${match[1]} on ticket #${ticket.id} was already checked on ${item.checked_at.slice(0, 10)}`);
  if (words(result) < 3) throw new Refused("--result must say what was found when the claim was checked, in a full sentence");
  const problems = [];
  findCredentials({ result }, "", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  item.result = result.trim();
  item.checked_at = now();
  save(db, ticket);
  console.log(`#${ticket.id} U${match[1]}: checked`);
  return 0;
}

async function cmdLink(args) {
  const item = { label: option(args, "--label"), target: option(args, "--target") };
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const problems = [];
  findCredentials(item, "", problems);
  validateLink(item, "the link", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  ticket.links = ticket.links || [];
  const index = ticket.links.push({ label: item.label.trim(), target: item.target.trim() });
  save(db, ticket);
  console.log(`#${ticket.id} L${index}: link added`);
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

/**
 * The commit a ticket points at when it is handed over for checking. A sentence saying "tested" proves nothing,
 * so the repository is asked: the commit exists, was made after the ticket, sits on the ticket's branch,
 * and nothing tracked is left uncommitted. Returns the full hash.
 */
function checkedCommit(ticket, ref) {
  if (!isText(ref)) throw new Refused(`#${ticket.id} is tied to branch ${ticket.branch}, so "review" needs --commit: the commit that holds the finished work`);
  const resolved = git(ticket.dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!resolved.ok || !resolved.out) throw new Refused(`${ref} is not a commit in ${ticket.dir}`);
  const hash = resolved.out;
  const committed = Number(git(ticket.dir, ["show", "-s", "--format=%ct", hash]).out);
  if (!(committed * 1000 >= Date.parse(ticket.created_at))) throw new Refused(`commit ${hash.slice(0, 10)} was made before the ticket was created, so it cannot be this ticket's work`);
  if (!git(ticket.dir, ["merge-base", "--is-ancestor", hash, ticket.branch]).ok) throw new Refused(`commit ${hash.slice(0, 10)} is not on ${ticket.branch}`);
  const dirty = git(ticket.dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.out) throw new Refused(`there are uncommitted changes in ${ticket.dir}; commit them first:\n${dirty.out}`);
  return hash;
}

/**
 * Accepted is not the same as merged. Once the work is on an integration branch that fact is recorded in the
 * ticket's history, after asking the repository: the branch exists and holds the commit the ticket was handed over with.
 * It is not a status, so a ticket can be merged into develop and later into main.
 */
async function cmdMerged(args) {
  const into = option(args, "--into");
  if (!args[0] || !isText(into)) throw new UsageError("usage: merged <id> --into <branch>");
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  if (!ticket.branch) throw new Refused(`#${ticket.id} has no branch (its project folder is not a git repository), so there is no merge to record`);
  if (!["review", "done"].includes(ticket.status)) throw new Refused(`#${ticket.id} is "${ticket.status}"; a merge is recorded for work that is in review or done`);
  if (!isText(ticket.commit)) throw new Refused(`#${ticket.id} carries no commit; it reaches review with --commit first`);
  if (mergedInto(ticket).includes(into)) throw new Refused(`#${ticket.id} is already recorded as merged into ${into}`);
  if (!git(ticket.dir, ["rev-parse", "--verify", "--quiet", `${into}^{commit}`]).ok) throw new Refused(`there is no branch ${into} in ${ticket.dir}`);
  if (!git(ticket.dir, ["merge-base", "--is-ancestor", ticket.commit, into]).ok) throw new Refused(`commit ${ticket.commit.slice(0, 10)} of ticket #${ticket.id} is not on ${into}; merge it first`);
  ticket.history = [...(ticket.history || []), { at: now(), merged: into, commit: ticket.commit }];
  save(db, ticket);
  console.log(`#${ticket.id}: merged into ${into}`);
  return 0;
}

/** A progress note: where the work stands and what comes next. It moves nothing; it is for the next session. */
async function cmdNote(args) {
  const text = option(args, "--text");
  if (!args[0]) throw new UsageError("usage: note <id> --text <where the work stands and what comes next>");
  if (words(text) < 5) throw new Refused("--text must say where the work stands and what comes next, in a full sentence");
  const problems = [];
  findCredentials({ text }, "", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  ticket.history = [...(ticket.history || []), { at: now(), note: text.trim() }];
  save(db, ticket);
  console.log(`#${ticket.id}: note added`);
  return 0;
}

/* ---------- commit guard ---------- */

/** Where a repository keeps its hooks, and whether that place is shared with the team through the working tree. */
function hooksOf(dir) {
  if (!isRepo(dir)) throw new Refused(`${dir} is not a git repository, so there are no commits to guard`);
  const top = git(dir, ["rev-parse", "--show-toplevel"]).out;
  const gitDir = path.resolve(top, git(dir, ["rev-parse", "--git-dir"]).out);
  const configured = git(dir, ["config", "--get", "core.hooksPath"]).out;
  const hooks = path.resolve(top, git(dir, ["rev-parse", "--git-path", "hooks"]).out);
  const inside = (parent, child) => { const rel = path.relative(parent, child); return !rel.startsWith("..") && !path.isAbsolute(rel); };
  return { hooks, configured, shared: Boolean(configured) && inside(path.resolve(top), hooks) && !inside(gitDir, hooks) };
}

// The two guards. Each is one hook file; an earlier hook of the same name can be kept and run first.
const GUARDS = [
  { hook: "pre-commit", mark: GUARD_MARK, what: "commit guard" },
  { hook: "pre-push", mark: "board-tools push guard", what: "push guard" },
];
const chainedName = (hook) => (hook === "pre-commit" ? CHAINED : `${hook}.before-board`);

function guardScript(hook) {
  const tool = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  const head = (mark, purpose) => `#!/bin/sh
# ${mark}: ${purpose}
# Installed by "board-tools hook install"; remove it with "board-tools hook remove".
hooks_dir=$(dirname "$0")
`;
  if (hook === "pre-push") {
    // git feeds the refs being pushed on stdin; an earlier hook would consume them, so they are kept and replayed.
    return `${head("board-tools push guard", "refuses a direct push to an integration branch; those are reached through a pull request.")}refs=$(cat)
if [ -f "$hooks_dir/${chainedName(hook)}" ]; then
  printf '%s\\n' "$refs" | "$hooks_dir/${chainedName(hook)}" "$@" || exit $?
fi
# There is no skip switch: an urgent fix goes through a hotfix branch and a pull request like any other.
if ! command -v node >/dev/null 2>&1; then
  echo "board guard: node was not found, so the push was not checked; push allowed" >&2
  exit 0
fi
printf '%s\\n' "$refs" | node --no-warnings "${tool}" hook check-push --dir "$(git rev-parse --show-toplevel)"
code=$?
[ "$code" -eq 1 ] && exit 1
[ "$code" -ne 0 ] && echo "board guard: the push could not be checked; push allowed" >&2
exit 0
`;
  }
  return `${head(GUARD_MARK, "refuses a commit on a work branch that has no ticket in progress.")}if [ -f "$hooks_dir/${CHAINED}" ]; then
  "$hooks_dir/${CHAINED}" "$@" || exit $?
fi
# The owner working alone can set BOARD_SKIP=1. Agents may not.
[ -n "$BOARD_SKIP" ] && exit 0
if ! command -v node >/dev/null 2>&1; then
  echo "board guard: node was not found, so the board was not checked; commit allowed" >&2
  exit 0
fi
node --no-warnings "${tool}" hook check --dir "$(git rev-parse --show-toplevel)"
code=$?
[ "$code" -eq 1 ] && exit 1
[ "$code" -ne 0 ] && echo "board guard: the board could not be checked; commit allowed" >&2
exit 0
`;
}

/** The integration branches of a project: its own list when one was set, the standard one otherwise. Never throws. */
async function protectedBranches(dir) {
  try {
    const db = await openDb();
    const row = db.prepare("SELECT protected FROM projects WHERE key = ?").get(projectOf(dir).key);
    if (row && isText(row.protected)) return { list: row.protected.split(","), own: true };
  } catch { /* a board that cannot be read must not unprotect the branches: fall through to the standard list */ }
  return { list: PROTECTED, own: false };
}

async function cmdHook(args) {
  const [action] = args.splice(0, 1);
  const dir = path.resolve(option(args, "--dir") || process.cwd());

  if (action === "check") {
    // Exit 0 lets the commit through, 1 refuses it, 2 means the board could not be asked (the guard then lets it through).
    try {
      const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
      if (!branch || UNGUARDED.includes(branch)) return 0;
      const gitDir = path.resolve(dir, git(dir, ["rev-parse", "--git-dir"]).out);
      if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return 0;
      const project = projectOf(dir).key;
      const db = await openDb();
      if (db.prepare("SELECT id FROM tickets WHERE project = ? AND branch = ? AND status IN ('doing', 'review')").get(project, branch)) return 0;
      const waiting = db.prepare("SELECT id, status FROM tickets WHERE project = ? AND branch = ? AND status = 'ready'").get(project, branch);
      console.error(`board guard: no ticket in progress for branch ${branch} in project ${project}.`);
      console.error(waiting
        ? `  Ticket #${waiting.id} is ready but not started: board-tools set ${waiting.id} --status doing`
        : "  Record the approved work first (board-tools add), then start it (board-tools set <id> --status doing).");
      return 1;
    } catch (error) {
      console.error(`board guard: ${error.message}`);
      return 2;
    }
  }

  if (action === "check-push") {
    // git gives one line per ref on stdin: <local ref> <local object> <remote ref> <remote object>.
    // Exit 0 lets the push through, 1 refuses it, 2 means it could not be checked (the guard then lets it through).
    try {
      const lines = fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      const targets = lines.map((l) => l.split(/\s+/)[2] || "").filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ref.slice("refs/heads/".length));
      const guarded = await protectedBranches(dir);
      const hit = [...new Set(targets.filter((branch) => guarded.list.includes(branch)))];
      if (!hit.length) return 0;
      console.error(`board guard: ${hit.join(", ")} ${hit.length > 1 ? "are integration branches" : "is an integration branch"} of this project and ${hit.length > 1 ? "are" : "is"} not pushed to directly.`);
      console.error("  Push your work branch and open a pull request into it instead.");
      console.error(`  Protected here: ${guarded.list.join(", ")}${guarded.own ? "" : " (the default list; change it with: board-tools project protect --branches ...)"}`);
      return 1;
    } catch (error) {
      console.error(`board guard: ${error.message}`);
      return 2;
    }
  }

  if (action === "install") {
    const existing = option(args, "--existing");
    if (existing !== undefined && !["chain", "replace", "skip"].includes(existing)) throw new UsageError("--existing must be chain, replace or skip");
    const where = hooksOf(dir);
    if (where.shared) {
      // Hooks kept in the working tree (core.hooksPath pointing inside it) are committed and reach the whole team.
      throw new Refused(`this repository keeps its hooks in ${where.hooks} (core.hooksPath = ${where.configured}), inside the working tree, where they are shared with everyone who clones it; the guard is not installed there. This project stays unguarded.`);
    }
    // Look at both hook files before touching either, so a refusal never leaves one guard installed and the other not.
    const foreign = GUARDS.filter((g) => { const file = path.join(where.hooks, g.hook); return fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(g.mark); });
    if (foreign.length && existing === undefined) {
      throw new Refused(`${foreign.map((g) => path.join(where.hooks, g.hook)).join(" and ")} already hold${foreign.length > 1 ? "" : "s"} another hook. Choose what happens to ${foreign.length > 1 ? "them" : "it"}:\n--existing chain    keep it; it runs first, then the guard\n--existing replace  the guard takes its place; the old hook is kept as a backup beside it\n--existing skip     leave this project unguarded`);
    }
    if (foreign.length && existing === "skip") { console.log(`left alone: ${foreign.map((g) => g.hook).join(", ")} (this project is not guarded)`); return 0; }
    if (existing === "chain") {
      const taken = foreign.map((g) => path.join(where.hooks, chainedName(g.hook))).filter((file) => fs.existsSync(file));
      if (taken.length) throw new Refused(`${taken.join(", ")} already exists; remove the earlier guard first with "hook remove"`);
    }
    fs.mkdirSync(where.hooks, { recursive: true });
    for (const g of GUARDS) {
      const file = path.join(where.hooks, g.hook);
      if (foreign.includes(g)) {
        fs.renameSync(file, path.join(where.hooks, existing === "chain" ? chainedName(g.hook) : `${g.hook}.backup-${now().slice(0, 19).replace(/[-:T]/g, "")}`));
      }
      fs.writeFileSync(file, guardScript(g.hook), { mode: 0o755 });
      console.log(`${g.what} installed: ${file}`);
    }
    return 0;
  }

  if (action === "remove") {
    const where = hooksOf(dir);
    let removed = 0;
    for (const g of GUARDS) {
      const file = path.join(where.hooks, g.hook);
      if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(g.mark)) continue;
      fs.rmSync(file);
      const chained = path.join(where.hooks, chainedName(g.hook));
      if (fs.existsSync(chained)) fs.renameSync(chained, file);
      console.log(`${g.what} removed: ${file}`);
      removed++;
    }
    if (!removed) console.log("no guard installed here");
    return 0;
  }

  throw new UsageError("usage: hook <install|check|check-push|remove> [--dir <path>] [--existing chain|replace|skip]");
}

async function cmdSet(args) {
  const status = option(args, "--status");
  const evidence = option(args, "--evidence");
  const reason = option(args, "--reason");
  const said = option(args, "--words");
  const commitRef = option(args, "--commit");
  if (!args[0] || !status) throw new UsageError("usage: set <id> --status <status> [--evidence <text>] [--commit <hash>] [--reason <text>] [--words <the owner's sentence>]");
  if (!STATUSES.includes(status)) throw new Refused(`status must be one of ${STATUSES.join(", ")}`);
  const db = await openDb();
  const ticket = getTicket(db, args[0]);
  const from = ticket.status;
  if (from === status) throw new Refused(`#${ticket.id} is already ${status}`);
  if (status === "idea") throw new Refused("a ticket cannot go back to being an idea");
  if (from === "idea" && status !== "cancelled") throw new Refused('an idea becomes work through "approve", which records the acceptance criteria, sources and the owner\'s approval');
  const step = { at: now(), from, to: status };
  if (status === "doing" && from === "ready" && ticket.branch) {
    // Work on a ticket happens on its branch, so the start is checked against the repository itself.
    const current = git(ticket.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!current.ok) throw new Refused(`cannot read the current branch of ${ticket.dir}: ${current.err || "git failed"}`);
    if (current.out !== ticket.branch) throw new Refused(`#${ticket.id} belongs to branch ${ticket.branch}, but the repository is on ${current.out}; switch to ${ticket.branch} before starting`);
  }
  if (status === "review") {
    // The agent's side of "done": there is something to point at.
    if (!isText(evidence)) throw new Refused('status "review" needs --evidence: the command and result, or swipe report, that shows the work is done');
    // Work cannot be handed over while it still rests on a guess.
    const open = (ticket.unverified || []).map((u, index) => (isText(u.result) ? "" : `U${index + 1}`)).filter(Boolean);
    if (open.length) throw new Refused(`${open.join(", ")} on ticket #${ticket.id} ${open.length > 1 ? "are" : "is"} not yet verified; check ${open.length > 1 ? "them" : "it"} and record what was found with "verify" before handing the work over`);
    if (ticket.branch) step.commit = checkedCommit(ticket, commitRef);
  } else if (status === "done") {
    // The owner's side of "done": the evidence exists and the owner accepted it.
    if (!isText(evidence) && !isText(ticket.evidence)) throw new Refused('status "done" needs --evidence, or a ticket that already carries evidence from "review"');
    if (!isText(said)) throw new Refused('status "done" needs --words: the owner\'s acceptance, verbatim');
  } else if (status === "doing" && (from === "review" || from === "done")) {
    // Sent back: the agreed criteria were not met. Changed criteria are a new ticket with "follows".
    if (!isText(reason) || !isText(said)) throw new Refused("sending a ticket back needs --reason (what is still missing) and --words (the owner's sentence, verbatim)");
    step.returned = true;
  } else if (status === "cancelled" && !isText(reason)) {
    throw new Refused('status "cancelled" needs --reason');
  }
  if (step.commit) ticket.commit = step.commit;
  if (isText(evidence)) { ticket.evidence = evidence.trim(); ticket.finished_at = step.at; step.evidence = ticket.evidence; }
  if (isText(reason)) step.reason = reason.trim();
  if (isText(said)) step.words = said.trim();
  const problems = [];
  findCredentials(step, "", problems);
  if (problems.length) throw new Refused(problems.join("\n"));
  ticket.status = status;
  ticket.history = [...(ticket.history || []), step];
  save(db, ticket);
  console.log(`#${ticket.id} is now ${status}${step.returned ? " (sent back)" : ""}`);
  return 0;
}

async function cmdList(args) {
  const filters = [];
  const values = [];
  for (const [name, column] of [["--project", "t.project"], ["--group", "p.grp"], ["--status", "t.status"], ["--type", "t.type"]]) {
    const value = option(args, name);
    if (value !== undefined) { filters.push(`${column} = ?`); values.push(name === "--status" || name === "--type" ? value : kebab(value)); }
  }
  // Stored stamps start with the owner's local date, so a date range is a comparison on that prefix.
  for (const [name, column, operator] of [["--created-from", "created_at", ">="], ["--created-to", "created_at", "<="], ["--updated-from", "updated_at", ">="], ["--updated-to", "updated_at", "<="]]) {
    const value = option(args, name);
    if (value === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError(`${name} must be a date as YYYY-MM-DD`);
    filters.push(`substr(t.${column}, 1, 10) ${operator} ?`);
    values.push(value);
  }
  if (flag(args, "--waiting")) filters.push("t.status NOT IN ('done', 'cancelled') AND (t.unanswered > 0 OR t.unseen > 0 OR t.status = 'review')");
  const limit = Number(option(args, "--limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive number");
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const db = await openDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t JOIN projects p ON p.key = t.project${where}`).get(...values).n;
  printRows(db.prepare(`${SELECT}${where} ORDER BY t.id DESC LIMIT ?`).all(...values, limit).map(rowToTicket), total);
  return 0;
}

const mergedInto = (t) => (t.history || []).filter((h) => h.merged).map((h) => h.merged);

const historyText = (h) => (h.note ? `${h.at.slice(0, 10)}: note: ${h.note}`
  : h.merged ? `${h.at.slice(0, 10)}: merged into ${h.merged}; commit: ${h.commit}`
  : [`${h.at.slice(0, 10)}: ${h.from ? `${h.from} to ${h.to}` : `recorded as ${h.to}`}${h.returned ? " (sent back)" : ""}`,
    h.reason ? `reason: ${h.reason}` : "", h.evidence ? `evidence: ${h.evidence}` : "", h.commit ? `commit: ${h.commit}` : "", h.words ? `owner's words: "${h.words}"` : ""].filter(Boolean).join("; "));

const byText = (d) => (isPending(d) ? "waiting for the owner" : d.decided_by === "agent" ? `decided by the agent, ${d.reviewed ? "seen" : "not yet seen"} by the owner` : "decided by the owner");

async function cmdShow(args) {
  const db = await openDb();
  const t = getTicket(db, args[0]);
  const out = [`#${t.id}  ${t.group}/${t.project}  ${t.status}`, `Title: ${t.title}`, `Created: ${t.created_at}`, `Updated: ${t.updated_at}`];
  const add = (label, value) => { if (isText(value)) out.push("", `${label}:`, value.trim()); };
  const followers = db.prepare("SELECT id FROM tickets WHERE follows = ? ORDER BY id").all(t.id).map((row) => `#${row.id}`);
  if (t.type) out.push(`Type: ${t.type}`);
  if (t.branch) out.push(`Branch: ${t.branch}`);
  if (mergedInto(t).length) out.push(`Merged into: ${mergedInto(t).join(", ")}`);
  if (t.follows) out.push(`Follows: #${t.follows}`);
  if (followers.length) out.push(`Continued by: ${followers.join(", ")}`);
  add("Summary", t.summary);
  add("Details", t.body);
  out.push("", "Done when:", ...(t.done_when?.length ? t.done_when.map((item) => `- ${item}`) : ["(not set; this ticket is still an idea)"]));
  out.push("", "Decisions:");
  if (!t.decisions?.length) out.push("(none)");
  (t.decisions || []).forEach((d, index) => {
    out.push(`K${index + 1} (${byText(d)}${d.decided_at ? `, ${d.decided_at.slice(0, 10)}` : ""}): ${d.question}`);
    if (isPending(d)) return;
    out.push(`  Chosen: ${d.chosen}`, `  Reason: ${d.reason}`, ...d.rejected.map((r) => `  Rejected: ${r.option}: ${r.reason}`));
    out.push(d.decided_by === "agent" ? `  Owner's sentence the agent relied on: "${d.authority}"` : `  Owner's words: "${d.user_words}"`);
  });
  if (t.out_of_scope?.length) out.push("", "Out of scope:", ...t.out_of_scope.map((item) => `- ${item}`));
  if (t.unverified?.length) {
    out.push("", "Not yet verified:");
    t.unverified.forEach((u, index) => {
      out.push(`U${index + 1} (${isText(u.result) ? `checked ${u.checked_at.slice(0, 10)}` : "open"}): ${u.claim}`);
      out.push(isText(u.result) ? `  Found: ${u.result}` : `  How to check: ${u.check}`);
    });
  }
  if (t.links?.length) out.push("", "Links:", ...t.links.map((l, index) => `L${index + 1}: ${l.label} | ${l.target}`));
  out.push("", "Sources:", ...(t.sources?.length ? t.sources.map((s, index) => `E${index + 1}: ${s.claim} | ${s.source}${isText(s.status) ? ` | ${s.status}` : ""}`) : ["(none)"]));
  if (t.approved_by) out.push("", t.approved_by === "agent" ? `Opened by the agent, relying on: "${t.authority}"` : `Approved by the owner: "${t.user_words}"`);
  add("Evidence", t.evidence ? `${t.evidence} (${t.finished_at})` : "");
  out.push("", "History:", ...(t.history || []).map(historyText));
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => iso.slice(0, 10);
const showDate = (iso) => { const [y, m, d] = day(iso).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// The board is an app-like set of pages, not a long document: no table of contents, one column,
// cards that are links, and a board that scrolls sideways. Everything else comes from the shared doc-style.
const PAGE_STYLE = `<style id="page-style">
  .wrap { grid-template-columns: minmax(0, 1fr); }
  /* The board wants the width of the screen; a ticket reads best at the width of its text. */
  .wrap:has(.board) { max-width: 1840px; height: 100vh; height: 100dvh; padding-bottom: 16px; grid-template-rows: minmax(0, 1fr); }
  .wrap:has(.board) > main { display: flex; flex-direction: column; min-height: 0; }
  #board { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .wrap:not(:has(.board)) { max-width: 940px; padding-bottom: 48px; }
  nav.toc, .toc-mobile { display: none; }
  header.doc h1 { margin-bottom: 0; }
  header.doc .meta { margin: 12px 0 0; }
  @media print { header.doc .theme-switch { display: none; } }
  .appbar { margin: 0 0 16px; font-weight: 600; }
  section.bare { margin-top: 20px; }
  section.bare + section.bare { margin-top: 28px; }
  #decisions .stack { gap: 16px; }
  #decisions .card > p { margin: 10px 0 0; }
  #decisions .card > ul { margin: 6px 0 0; }
  #decisions .card > blockquote { margin: 14px 0 0; }
  section.bare > h2 { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* One gap for all five controls, so Created and Updated do not sit closer together than their neighbours. */
  .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .filters .chips { margin: 0; flex-wrap: nowrap; gap: 12px; }
  .filters input[type="search"] { font: 500 15px var(--body); color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 999px; padding: 9px 16px; min-height: 40px; }
  .filters input[type="search"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .title-search { flex: 1 1 220px; max-width: 360px; min-width: 0; }
  .picker-panel.narrow { width: min(220px, 86vw); }
  .picker-panel.narrow ul { margin: 0; }
  .picker > button::after { content: "\\25BE"; margin-left: 8px; }
  .more { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
  .more .chip { font-size: 13px; }
  .picker-panel { position: fixed; z-index: 5; width: min(320px, 86vw); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 16px; padding: 10px; box-shadow: 0 12px 32px rgb(0 0 0 / .18); }
  .picker-panel input[type="search"] { width: 100%; }
  .picker-panel ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 280px; overflow-y: auto; }
  .picker-panel [role="option"] { display: block; width: 100%; text-align: left; border: 0; background: none; color: inherit; font: 500 15px var(--body); padding: 9px 12px; border-radius: 10px; cursor: pointer; }
  .picker-panel [role="option"]:hover, .picker-panel [role="option"]:focus-visible { background: var(--accent-soft); outline: none; }
  .picker-panel [role="option"][aria-selected="true"] { font-weight: 700; color: var(--accent); }
  /* When the controls do not fit, the row stays one row and scrolls sideways, like the board under it. */
  @media (max-width: 1000px) {
    /* The padding leaves room for a focus ring, which a scrolling row would otherwise cut off at its edges. */
    .filters { flex-wrap: nowrap; overflow-x: auto; padding: 4px 4px 8px; margin: -4px -4px 0; }
    .filters > * { flex: none; }
    .filters .chip { white-space: nowrap; }
    .title-search { width: 220px; max-width: none; }
  }
  /* The board page itself does not scroll: the board takes what is left of the screen and scrolls in both
     directions inside its own box, with the column headings pinned to its top while the cards move under them. */
  .board { overflow: auto; flex: 1 1 auto; min-height: 0; scroll-snap-type: x proximity; }
  /* The lanes are as tall as the longest column, so a short column's heading stays pinned as long as a long one's. */
  .lanes { display: flex; gap: 16px; align-items: stretch; width: max-content; min-height: 100%; padding-bottom: 12px; }
  .lanes > div { flex: 0 0 min(300px, 82vw); scroll-snap-align: start; }
  .board h3 { position: sticky; top: 0; z-index: 2; background: var(--canvas); margin: 0; padding: 4px 0 14px; display: flex; align-items: center; gap: 8px; }
  .board .stack { margin: 0; }
  a.ticket { display: block; color: inherit; text-decoration: none; padding: 18px; }
  a.ticket:hover, a.ticket:focus-visible { border-color: var(--accent); }
  a.ticket h4 { margin: 0; line-height: 1.4; }
  a.ticket .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; }
  a.ticket .pill { white-space: normal; vertical-align: 0; }
  a.ticket .dates { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
  .column-empty { color: var(--muted); font-size: 14px; }
  dialog.range { border: 1px solid var(--line); border-radius: 20px; background: var(--surface); color: var(--ink); padding: 24px; width: min(700px, calc(100vw - 2rem)); }
  dialog.range::backdrop { background: rgb(0 0 0 / .45); }
  /* The dialog keeps one rhythm: 12px between buttons, 20px between its four blocks. */
  .range-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin: 0 0 20px; }
  .range-row h3 { margin: 0; }
  .range-row.foot { margin: 20px 0 0; padding-top: 20px; border-top: 1px solid var(--line); }
  .range-row > span { display: flex; gap: 12px; }
  dialog.range .chips { margin: 0 0 20px; gap: 12px; }
  .range-months { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; }
  .range-months p { margin: 0 0 10px; }
  @media (max-width: 620px) { .range-months { grid-template-columns: minmax(0, 1fr); } }
  .range-months p { text-align: center; font-weight: 600; }
  .range-months th { padding-bottom: 8px; }
  .range-months table { width: 100%; min-width: 0; font-size: 14px; table-layout: fixed; border-collapse: collapse; text-align: center; border: 0; background: none; }
  .range-months th { font-size: 12px; color: var(--muted); padding: 0 0 4px; background: none; border: 0; text-align: center; }
  .range-months td { padding: 0; border: 0; }
  .range-months td button { width: 100%; height: 40px; border: 0; background: none; color: inherit; font: inherit; font-variant-numeric: tabular-nums; cursor: pointer; border-radius: 10px; }
  .range-months td button:hover { background: var(--accent-soft); }
  .range-months td button.in-range { background: var(--accent-soft); border-radius: 0; }
  .range-months td button.edge { background: var(--accent); color: var(--on-accent); font-weight: 700; border-radius: 10px; }
  .range-months td button.today { font-weight: 700; text-decoration: underline; text-underline-offset: 4px; }
</style>`;

// The range picker follows the one in the owner's pentahoot project (resources/js/date-range.js): dates are
// YYYY-MM-DD strings counted with UTC arithmetic, the first click starts a range and the second closes it,
// and the keys follow the W3C APG date grid (arrows, Page Up/Down, Home/End, Enter).
const PAGE_SCRIPT = `<script id="page-script">
(function () {
  var bar = document.querySelector("[data-board-filters]");
  if (!bar) return;
  var all = function (selector, root) { return [].slice.call((root || document).querySelectorAll(selector)); };
  var KEY = "board-filters";
  var DAY = 86400000;
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var SHORT = MONTHS.map(function (m) { return m.slice(0, 3); });
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var local = new Date();
  var today = local.getFullYear() + "-" + pad(local.getMonth() + 1) + "-" + pad(local.getDate());

  function toTime(date) { var p = date.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
  function fromTime(time) { return new Date(time).toISOString().slice(0, 10); }
  function addDays(date, days) { return fromTime(toTime(date) + days * DAY); }
  function addMonths(date, months) {
    var p = date.split("-").map(Number);
    var target = new Date(Date.UTC(p[0], p[1] - 1 + months, 1));
    var last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(p[2], last));
    return fromTime(target.getTime());
  }
  function weekday(date) { return (new Date(toTime(date)).getUTCDay() + 6) % 7; }
  function firstOf(date) { return date.slice(0, 7) + "-01"; }
  function show(date) { var p = date.split("-").map(Number); return p[2] + " " + SHORT[p[1] - 1] + " " + p[0]; }

  var state = { project: "", field: "created", from: "", to: "", title: "", sort: "updated", dir: "desc" };
  var searchBox = bar.querySelector("[data-title-search]");
  var sortDir = bar.querySelector("[data-sort-dir]");
  var PAGE = ${PAGE_SIZE};
  var columns = all("[data-column]");
  var limits = [];
  var SORTS = {
    updated: function (card) { return Number(card.getAttribute("data-ut")); },
    created: function (card) { return Number(card.getAttribute("data-ct")); },
    number: function (card) { return Number(card.getAttribute("data-id")); },
    title: function (card) { var text = card.querySelector("h4").textContent; return text.slice(text.indexOf("\\u00b7") + 1).trim().toLowerCase(); }
  };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || "{}"); for (var k in state) if (typeof saved[k] === "string") state[k] = saved[k]; } catch (e) { /* filters still work without storage */ }
  // One dropdown for every choice in the filter row: a chip that opens a list, with a search box when the list can be long.
  function makePicker(root, onPick) {
    var open = root.querySelector("[data-picker-open]");
    var panel = root.querySelector("[data-picker-panel]");
    var search = root.querySelector("[data-picker-search]");
    var none = root.querySelector("[data-picker-none]");
    var options = all('[role="option"]', root);
    var listed = function () { return options.filter(function (b) { return !b.parentNode.hidden; }); };
    function narrow() {
      var wanted = search ? search.value.trim().toLowerCase() : "";
      options.forEach(function (b) { b.parentNode.hidden = wanted !== "" && b.textContent.toLowerCase().indexOf(wanted) === -1; });
      if (none) none.hidden = listed().length > 0;
    }
    // The list is placed against the screen, not inside the filter row: on a phone that row scrolls sideways and would clip it.
    function place() {
      var button = open.getBoundingClientRect();
      panel.style.top = Math.round(button.bottom + 6) + "px";
      panel.style.left = Math.round(Math.max(8, Math.min(button.left, window.innerWidth - panel.offsetWidth - 8))) + "px";
    }
    function toggle(show) {
      panel.hidden = !show;
      open.setAttribute("aria-expanded", String(show));
      if (!show) return;
      if (search) search.value = "";
      narrow();
      place();
      (search || options.filter(function (b) { return b.getAttribute("aria-selected") === "true"; })[0] || options[0]).focus();
    }
    open.addEventListener("click", function () { toggle(panel.hidden); });
    if (search) search.addEventListener("input", narrow);
    options.forEach(function (b) { b.addEventListener("click", function () { toggle(false); onPick(b.getAttribute("data-value")); open.focus(); }); });
    // Arrow keys walk the options still listed, Enter in the search box takes the first one, Escape closes.
    root.addEventListener("keydown", function (event) {
      if (panel.hidden) return;
      var shown = listed();
      var at = shown.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); toggle(false); open.focus(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); if (shown.length) shown[Math.min(at + 1, shown.length - 1)].focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); if (at <= 0) { if (search) search.focus(); } else shown[at - 1].focus(); }
      else if (event.key === "Enter" && search && document.activeElement === search) { event.preventDefault(); if (shown.length) shown[0].click(); }
    });
    document.addEventListener("click", function (event) { if (!panel.hidden && !root.contains(event.target)) toggle(false); });
    window.addEventListener("resize", function () { if (!panel.hidden) toggle(false); });
    window.addEventListener("scroll", function (event) { if (!panel.hidden && !panel.contains(event.target)) toggle(false); }, true);
    return {
      has: function (value) { return options.some(function (b) { return b.getAttribute("data-value") === value; }); },
      // Marks the chosen option and writes it on the chip.
      choose: function (value, label) {
        options.forEach(function (b) {
          var chosen = b.getAttribute("data-value") === value;
          b.setAttribute("aria-selected", String(chosen));
          if (chosen) open.textContent = label ? label(b.textContent) : b.textContent;
        });
      },
      open: open
    };
  }
  var projectPicker = makePicker(bar.querySelector("[data-project-picker]"), function (value) { state.project = value; apply(); });
  var sortPicker = makePicker(bar.querySelector("[data-sort-picker]"), function (value) { state.sort = value; apply(); });
  var openButton = bar.querySelector("[data-range-open]");
  var dialog = document.querySelector("dialog[data-range]");
  // Which date the range filters on is chosen inside the dialog, next to the range itself, and applied with it.
  var fieldButtons = all("[data-date-field]", dialog);
  var draftField = "created";
  function showField() { fieldButtons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-date-field") === draftField)); }); }
  var grid = dialog.querySelector("[data-range-grid]");
  var draft = { from: "", to: "" };
  var focusDay = today;
  var shownMonth = firstOf(today);

  function apply() {
    if (!projectPicker.has(state.project)) state.project = "";
    if (state.field !== "updated") state.field = "created";
    var to = state.to || state.from;
    projectPicker.choose(state.project);
    projectPicker.open.setAttribute("aria-pressed", String(state.project !== ""));
    openButton.textContent = state.from ? (state.field === "updated" ? "Updated: " : "Created: ") + (to === state.from ? show(state.from) : show(state.from) + " – " + show(to)) : "Any date";
    if (!SORTS[state.sort]) state.sort = "updated";
    if (state.dir !== "asc") state.dir = "desc";
    sortPicker.choose(state.sort, function (text) { return "Sort: " + text.toLowerCase(); });
    sortDir.textContent = state.dir === "asc" ? "\\u2191" : "\\u2193";
    sortDir.setAttribute("aria-label", state.dir === "asc" ? "Ascending; switch to descending" : "Descending; switch to ascending");
    openButton.setAttribute("aria-pressed", String(Boolean(state.from)));
    var wanted = state.title.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    if (searchBox.value !== state.title) searchBox.value = state.title;
    all("[data-project]").forEach(function (el) {
      var date = el.getAttribute("data-" + state.field) || "";
      var heading = el.querySelector("h4");
      var title = heading ? heading.textContent.toLowerCase() : "";
      var inProject = state.project === "" || el.getAttribute("data-project") === state.project;
      var inRange = !state.from || (date >= state.from && date <= to);
      // Every word typed must appear in the title, in any order.
      var inTitle = wanted.every(function (word) { return title.indexOf(word) !== -1; });
      el.boardMatch = inProject && inRange && inTitle;
    });
    var sign = state.dir === "asc" ? 1 : -1;
    var key = SORTS[state.sort];
    columns.forEach(function (col, index) {
      var stack = col.querySelector(".stack");
      var cards = all("[data-project]", stack);
      // Ties fall back to the ticket number, so the order never depends on where a card happened to be.
      cards.sort(function (a, b) { var x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : Number(a.getAttribute("data-id")) - Number(b.getAttribute("data-id"))) * sign; });
      cards.forEach(function (card) { stack.appendChild(card); });
      var matching = cards.filter(function (card) { return card.boardMatch; });
      var limit = Math.max(PAGE, limits[index] || PAGE);
      cards.forEach(function (card) { card.hidden = true; });
      matching.slice(0, limit).forEach(function (card) { card.hidden = false; });
      col.querySelector("[data-count]").textContent = String(matching.length);
      col.querySelector(".column-empty").hidden = matching.length > 0;
      var left = matching.length - limit;
      var more = col.querySelector("[data-more]");
      more.hidden = left <= 0;
      more.textContent = "Show " + Math.min(PAGE, left) + " more (" + left + " left)";
      col.querySelector("[data-less]").hidden = limit <= PAGE || matching.length <= PAGE;
    });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* see above */ }
  }

  function monthHtml(first) {
    var p = first.split("-").map(Number);
    var last = addDays(addMonths(first, 1), -1);
    var cursor = addDays(first, -weekday(first));
    var end = addDays(last, 6 - weekday(last));
    var rangeEnd = draft.to || draft.from;
    var rows = "";
    while (cursor <= end) {
      rows += "<tr>";
      for (var i = 0; i < 7; i++) {
        if (cursor.slice(0, 7) === first.slice(0, 7)) {
          var classes = [cursor === draft.from || cursor === draft.to ? "edge" : (draft.from && cursor >= draft.from && cursor <= rangeEnd ? "in-range" : ""), cursor === today ? "today" : ""].join(" ").trim();
          rows += '<td role="gridcell"><button type="button" data-day="' + cursor + '" tabindex="' + (cursor === focusDay ? 0 : -1) + '" aria-label="' + show(cursor) + '"' + (classes ? ' class="' + classes + '"' : "") + ">" + Number(cursor.slice(8)) + "</button></td>";
        } else rows += "<td></td>";
        cursor = addDays(cursor, 1);
      }
      rows += "</tr>";
    }
    var name = MONTHS[p[1] - 1] + " " + p[0];
    return "<div><p>" + name + '</p><table role="grid" aria-label="' + name + '"><thead><tr><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th><th>Su</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }
  function draw(focus) {
    grid.innerHTML = monthHtml(shownMonth) + monthHtml(addMonths(shownMonth, 1));
    if (focus) { var cell = grid.querySelector('[data-day="' + focusDay + '"]'); if (cell) cell.focus(); }
  }
  function pick(date) {
    if (draft.from === "" || draft.to !== "") draft = { from: date, to: "" };
    else draft = date < draft.from ? { from: date, to: draft.from } : { from: draft.from, to: date };
    focusDay = date;
    draw(true);
  }
  var PRESETS = {
    today: function () { return { from: today, to: today }; },
    last7: function () { return { from: addDays(today, -6), to: today }; },
    last30: function () { return { from: addDays(today, -29), to: today }; },
    month: function () { return { from: firstOf(today), to: addDays(addMonths(firstOf(today), 1), -1) }; }
  };
  var MOVES = { ArrowLeft: function (d) { return addDays(d, -1); }, ArrowRight: function (d) { return addDays(d, 1); }, ArrowUp: function (d) { return addDays(d, -7); }, ArrowDown: function (d) { return addDays(d, 7); },
    PageUp: function (d) { return addMonths(d, -1); }, PageDown: function (d) { return addMonths(d, 1); }, Home: function (d) { return addDays(d, -weekday(d)); }, End: function (d) { return addDays(d, 6 - weekday(d)); } };

  fieldButtons.forEach(function (b) { b.addEventListener("click", function () { draftField = b.getAttribute("data-date-field"); showField(); }); });
  searchBox.addEventListener("input", function () { state.title = searchBox.value; apply(); });
  sortDir.addEventListener("click", function () { state.dir = state.dir === "asc" ? "desc" : "asc"; apply(); });
  columns.forEach(function (col, index) {
    col.querySelector("[data-more]").addEventListener("click", function () { limits[index] = (limits[index] || PAGE) + PAGE; apply(); });
    col.querySelector("[data-less]").addEventListener("click", function () { limits[index] = PAGE; apply(); });
  });
  openButton.addEventListener("click", function () {
    draft = { from: state.from, to: state.to };
    draftField = state.field;
    showField();
    focusDay = state.from || today;
    shownMonth = firstOf(addMonths(focusDay, focusDay.slice(0, 7) === today.slice(0, 7) ? -1 : 0));
    dialog.showModal();
    draw(true);
  });
  grid.addEventListener("click", function (event) { var cell = event.target.closest("[data-day]"); if (cell) pick(cell.getAttribute("data-day")); });
  grid.addEventListener("keydown", function (event) {
    var move = MOVES[event.key];
    if (!move) return; // Enter and Space reach the focused day button as a click
    event.preventDefault();
    focusDay = move(focusDay);
    if (focusDay < shownMonth) shownMonth = firstOf(focusDay);
    else if (focusDay > addDays(addMonths(shownMonth, 2), -1)) shownMonth = firstOf(addMonths(focusDay, -1));
    draw(true);
  });
  all("[data-range-shift]", dialog).forEach(function (b) { b.addEventListener("click", function () { shownMonth = addMonths(shownMonth, Number(b.getAttribute("data-range-shift"))); draw(false); }); });
  all("[data-range-preset]", dialog).forEach(function (b) { b.addEventListener("click", function () { draft = PRESETS[b.getAttribute("data-range-preset")](); focusDay = draft.from; shownMonth = firstOf(draft.from); draw(false); }); });
  dialog.querySelector("[data-range-clear]").addEventListener("click", function () { draft = { from: "", to: "" }; draw(false); });
  dialog.querySelector("[data-range-cancel]").addEventListener("click", function () { dialog.close(); });
  dialog.querySelector("[data-range-apply]").addEventListener("click", function () { state.from = draft.from; state.to = draft.to; state.field = draftField; dialog.close(); apply(); });
  apply();
})();
</script>`;

const section = (id, number, heading, body, bare = false) => `    <section id="${id}"${bare ? ' class="bare"' : ""}>
      <h2><span class="num">${String(number).padStart(2, "0")}</span>${heading}</h2>
${body}
    </section>`;

function boardCard(t) {
  const c = counts(t);
  const pills = [t.type ? `<span class="pill solid">${esc(t.type)}</span>` : "",
    `<span class="pill info">${esc(t.group)} / ${esc(t.project)}</span>`,
    columnOf(t) !== t.status ? `<span class="pill accent">${STATUS_LABEL[t.status]}</span>` : "",
    c.unanswered ? `<span class="pill warn">${c.unanswered} question${c.unanswered > 1 ? "s" : ""} for you</span>` : "",
    c.unseen ? `<span class="pill warn">${c.unseen} agent decision${c.unseen > 1 ? "s" : ""} to review</span>` : "",
    c.unverified ? `<span class="pill warn">${c.unverified} to verify</span>` : "",
    c.returned ? `<span class="pill danger">Sent back ${c.returned}×</span>` : "",
    ...mergedInto(t).map((branch) => `<span class="pill ok">Merged into ${esc(branch)}</span>`)].filter(Boolean).join(" ");
  return `          <a class="card ticket" href="ticket-${t.id}.html" data-project="${esc(t.project)}" data-created="${day(t.created_at)}" data-updated="${day(t.updated_at)}" data-id="${t.id}" data-ct="${Date.parse(t.created_at)}" data-ut="${Date.parse(t.updated_at)}">
            <h4>#${t.id} · ${esc(t.title)}</h4>
            <p class="pills">${pills}</p>
            <p class="dates">Created ${showDate(t.created_at)} · Updated ${showDate(t.updated_at)}</p>
          </a>`;
}

const boardColumn = (title, tickets) => `        <div data-column>
          <h3>${title} <span class="pill muted" data-count>${tickets.length}</span></h3>
          <div class="stack">
${tickets.map(boardCard).join("\n")}
          </div>
          <p class="column-empty"${tickets.length ? " hidden" : ""}>Nothing here.</p>
          <p class="more"><button class="chip" type="button" data-more hidden>Show more</button> <button class="chip" type="button" data-less hidden>Show less</button></p>
        </div>`;

const RANGE_DIALOG = `      <dialog class="range" data-range aria-labelledby="range-title">
        <div class="range-row">
          <h3 id="range-title">Date range</h3>
          <span>
            <button class="chip" type="button" data-range-shift="-1" aria-label="Previous month">&lsaquo;</button>
            <button class="chip" type="button" data-range-shift="1" aria-label="Next month">&rsaquo;</button>
          </span>
        </div>
        <div class="chips" role="group" aria-label="Which date the range applies to">
          <button class="chip" type="button" data-date-field="created" aria-pressed="true">Date created</button>
          <button class="chip" type="button" data-date-field="updated" aria-pressed="false">Date updated</button>
        </div>
        <div class="chips" role="group" aria-label="Quick ranges">
          <button class="chip" type="button" data-range-preset="today">Today</button>
          <button class="chip" type="button" data-range-preset="last7">Last 7 days</button>
          <button class="chip" type="button" data-range-preset="last30">Last 30 days</button>
          <button class="chip" type="button" data-range-preset="month">This month</button>
        </div>
        <div class="range-months" data-range-grid></div>
        <div class="range-row foot">
          <button class="chip" type="button" data-range-clear>Clear</button>
          <span>
            <button class="chip" type="button" data-range-cancel>Cancel</button>
            <button class="chip" type="button" data-range-apply aria-pressed="true">Apply</button>
          </span>
        </div>
      </dialog>`;

function boardSections(tickets, projects) {
  const options = ['<li><button type="button" role="option" data-board-filter="" data-value="" aria-selected="true">All projects</button></li>',
    ...projects.map((p) => `<li><button type="button" role="option" data-board-filter="${esc(p.key)}" data-value="${esc(p.key)}" aria-selected="false">${esc(p.grp)} / ${esc(p.key)}</button></li>`)].join("\n              ");
  const sorts = [["updated", "Updated"], ["created", "Created"], ["title", "Title"], ["number", "Ticket number"]]
    .map(([value, label], index) => `<li><button type="button" role="option" data-sort-option="${value}" data-value="${value}" aria-selected="${index === 0}">${label}</button></li>`).join("\n              ");
  // Written newest update first, which is also the order the page starts in.
  const recent = [...tickets].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
  const columns = COLUMNS.map(([key, title]) => boardColumn(title, recent.filter((t) => columnOf(t) === key))).join("\n");
  return [section("filters", 0, "Filters", `      <div class="filters" data-board-filters>
        <div class="picker" data-project-picker>
          <button class="chip" type="button" data-picker-open data-project-open aria-haspopup="listbox" aria-expanded="false">All projects</button>
          <div class="picker-panel" data-picker-panel data-project-panel hidden>
            <input type="search" data-picker-search data-project-search placeholder="Find a project" aria-label="Find a project" autocomplete="off">
            <ul role="listbox" aria-label="Project">
              ${options}
            </ul>
            <p class="column-empty" data-picker-none data-project-none hidden>No project matches.</p>
          </div>
        </div>
        <input class="title-search" type="search" data-title-search placeholder="Search by title" aria-label="Search by title" autocomplete="off">
        <button class="chip" type="button" data-range-open aria-haspopup="dialog" aria-pressed="false">Any date</button>
        <div class="picker" data-sort-picker>
          <button class="chip" type="button" data-picker-open data-sort-open aria-haspopup="listbox" aria-expanded="false">Sort: updated</button>
          <div class="picker-panel narrow" data-picker-panel data-sort-panel hidden>
            <ul role="listbox" aria-label="Sort by">
              ${sorts}
            </ul>
          </div>
        </div>
        <button class="chip" type="button" data-sort-dir aria-label="Descending; switch to ascending">&darr;</button>
      </div>
${RANGE_DIALOG}`, true),
  section("board", 1, "Board", `      <div class="board"><div class="lanes">
${columns}
      </div></div>`, true)].join("\n\n");
}

function decisionCard(d, index) {
  const head = `<h4>K${index + 1} · ${esc(d.question)}</h4>`;
  if (isPending(d)) return `      <div class="card">${head}<p><span class="pill warn">Waiting for your answer</span></p></div>`;
  const pill = d.decided_by === "agent"
    ? `<span class="pill ${d.reviewed ? "muted" : "warn"}">Decided by the agent${d.reviewed ? "" : ", not yet seen by you"}</span>`
    : '<span class="pill ok">Decided by you</span>';
  const quote = d.decided_by === "agent"
    ? `<blockquote><p>"${esc(d.authority)}"</p><footer>Your sentence the agent relied on to decide.</footer></blockquote>`
    : `<blockquote><p>"${esc(d.user_words)}"</p><footer>Your words.</footer></blockquote>`;
  return `      <div class="card">${head}
        <p>${pill} <span class="lbl">${showDate(d.decided_at)}</span></p>
        <p><b>Chosen.</b> ${esc(d.chosen)}</p>
        <p><b>Reason.</b> ${esc(d.reason)}</p>
        <p><b>Rejected.</b></p>
        <ul>${d.rejected.map((r) => `<li><b>${esc(r.option)}:</b> ${esc(r.reason)}</li>`).join("")}</ul>
        ${quote}
      </div>`;
}

function historyRow(h) {
  if (h.note) return `          <tr><td class="nowrap">${showDate(h.at)}</td><td>Progress note</td><td>${esc(h.note)}</td></tr>`;
  if (h.merged) return `          <tr><td class="nowrap">${showDate(h.at)}</td><td><span class="pill ok">Merged into ${esc(h.merged)}</span></td><td><b>Commit.</b> <code>${esc(h.commit.slice(0, 10))}</code></td></tr>`;
  const what = h.returned ? `Sent back to ${STATUS_LABEL[h.to]}` : h.from ? `${STATUS_LABEL[h.from]} to ${STATUS_LABEL[h.to]}` : `Recorded as ${STATUS_LABEL[h.to]}`;
  const notes = [h.reason ? `<b>Reason.</b> ${esc(h.reason)}` : "", h.evidence ? `<b>Evidence.</b> ${esc(h.evidence)}` : "", h.commit ? `<b>Commit.</b> <code>${esc(h.commit.slice(0, 10))}</code>` : "", h.words ? `<b>Your words.</b> "${esc(h.words)}"` : ""].filter(Boolean).join("<br>");
  return `          <tr><td class="nowrap">${showDate(h.at)}</td><td>${h.returned ? `<span class="pill danger">${what}</span>` : what}</td><td>${notes}</td></tr>`;
}

function ticketSections(t, followers) {
  const approval = !t.approved_by ? "<p>This ticket is still an idea: it has not been through a panel and you have not approved it.</p>"
    : t.approved_by === "agent"
      ? `<blockquote><p>"${esc(t.authority)}"</p><footer>The agent opened this ticket, relying on your sentence above.</footer></blockquote>`
      : `<blockquote><p>"${esc(t.user_words)}"</p><footer>Your approval.</footer></blockquote>`;
  const links = [t.follows ? `Follows <a href="ticket-${t.follows}.html">ticket #${t.follows}</a>.` : "",
    followers.length ? `Continued by ${followers.map((id) => `<a href="ticket-${id}.html">ticket #${id}</a>`).join(", ")}.` : ""].filter(Boolean).join(" ");
  // A link to a web address is clickable; a path inside a project is shown as text, because the page cannot know where that project lives.
  const linkTarget = (target) => (/^https?:\/\//i.test(target) ? `<a href="${esc(target)}">${esc(target)}</a>` : `<code>${esc(target)}</code>`);
  // Sections that have nothing to show are left out, so the numbering is given once the list is known.
  const parts = [
    ["summary", "Summary", `${links ? `      <p>${links}</p>\n` : ""}      <p>${esc(t.summary)}</p>
${isText(t.body) ? `      <p>${esc(t.body)}</p>\n` : ""}      ${approval}`],
    ["decisions", "Decisions", t.decisions?.length ? `      <div class="stack">
${t.decisions.map(decisionCard).join("\n")}
      </div>` : "      <p>No decisions recorded for this ticket yet.</p>"],
    ["done-when", "Done when", `${t.done_when?.length ? `      <ul>
${t.done_when.map((item) => `        <li>${esc(item)}</li>`).join("\n")}
      </ul>` : "      <p>Not set yet. The criteria are added when the idea is approved as work.</p>"}${isText(t.evidence) ? `\n      <div class="card"><h4>Evidence</h4><p>${esc(t.evidence)}</p><p class="lbl">${showDate(t.finished_at)}</p></div>` : ""}`],
    t.out_of_scope?.length ? ["out-of-scope", "Out of scope", `      <ul>
${t.out_of_scope.map((item) => `        <li>${esc(item)}</li>`).join("\n")}
      </ul>`] : null,
    t.unverified?.length ? ["unverified", "Not yet verified", `      <div class="stack">
${t.unverified.map((u, index) => `      <div class="card"><h4>U${index + 1} · ${esc(u.claim)}</h4>
        ${isText(u.result)
    ? `<p><span class="pill ok">Checked</span> <span class="lbl">${showDate(u.checked_at)}</span></p>\n        <p><b>Found.</b> ${esc(u.result)}</p>`
    : `<p><span class="pill warn">Still a guess</span></p>\n        <p><b>How to check.</b> ${esc(u.check)}</p>`}
      </div>`).join("\n")}
      </div>`] : null,
    ["sources", "Sources", t.sources?.length ? `      <div class="table-scroll"><table>
        <thead><tr><th>ID</th><th>Claim</th><th>Source</th><th>Status</th></tr></thead>
        <tbody>
${t.sources.map((s, index) => `          <tr><td class="id">E${index + 1}</td><td>${esc(s.claim)}</td><td>${esc(s.source)}</td><td>${esc(s.status || "")}</td></tr>`).join("\n")}
        </tbody>
      </table></div>` : "      <p>No sources recorded yet.</p>"],
    t.links?.length ? ["links", "Links", `      <ul>
${t.links.map((l) => `        <li><b>${esc(l.label)}:</b> ${linkTarget(l.target)}</li>`).join("\n")}
      </ul>`] : null,
    ["history", "History", `      <div class="table-scroll"><table>
        <thead><tr><th>Date</th><th>Change</th><th>Notes</th></tr></thead>
        <tbody>
${(t.history || []).map(historyRow).join("\n")}
        </tbody>
      </table></div>`],
  ];
  return parts.filter(Boolean).map(([id, heading, body], index) => section(id, index, heading, body)).join("\n\n");
}

/** One edit to the document template. Each must match, so a template change fails loudly instead of leaking old text. */
function swap(html, pattern, replacement) {
  const next = html.replace(pattern, replacement);
  if (next === html) throw new UsageError(`the doc-tools template changed shape: nothing matches ${pattern}`);
  return next;
}

// An open page notices that it is out of date and reloads itself. There is no server: every few seconds the page
// loads the small stamp file beside it and compares the stamp for this page with the one it was built with.
// It waits while a dialog or dropdown is open or a field has the focus, and it keeps the scroll position.
const WATCH_SCRIPT = `<script id="watch-script">
(function () {
  var mine = document.querySelector('meta[name="board-stamp"]');
  var which = document.querySelector('meta[name="board-page"]');
  if (!mine || !which) return;
  var page = which.getAttribute("content");
  var built = mine.getAttribute("content");
  var KEY = "board-scroll:" + page;
  var board = document.querySelector(".board");
  try {
    var kept = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (kept) {
      sessionStorage.removeItem(KEY);
      window.scrollTo(0, kept.y);
      if (board) { board.scrollTop = kept.top; board.scrollLeft = kept.left; }
    }
  } catch (e) { /* the page still reloads without a remembered position */ }
  window.__boardStamp = function (stamps) {
    var latest = page === "board" ? stamps.board : (stamps.tickets || {})[page];
    if (!latest || latest === built) return;
    var busy = document.querySelector("dialog[open]") || document.querySelector("[data-picker-panel]:not([hidden])") || (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    if (busy) return;
    try { sessionStorage.setItem(KEY, JSON.stringify({ y: window.scrollY, top: board ? board.scrollTop : 0, left: board ? board.scrollLeft : 0 })); } catch (e) { /* see above */ }
    location.reload();
  };
  setInterval(function () {
    var probe = document.createElement("script");
    probe.src = "stamp.js?" + Date.now();
    probe.onload = probe.onerror = function () { probe.remove(); };
    document.head.appendChild(probe);
  }, ${WATCH_INTERVAL_MS});
})();
</script>`;

function makePage(template, { tab, title, eyebrow, meta, appbar, sections, stamp = "", page = "", watch = "" }) {
  const start = template.indexOf('<section id="ringkasan">');
  const end = template.indexOf('<footer class="doc">');
  if (start === -1 || end === -1) throw new UsageError("the doc-tools template changed shape: cannot find the first section or the footer");
  let html = `${template.slice(0, start)}${sections.trimStart()}\n\n    ${template.slice(end)}`;
  // The theme switch moves into the header card; the toolbar row it came from is dropped.
  const themeSwitch = /<div class="theme-switch"[^]*?<\/div>/.exec(html);
  if (!themeSwitch) throw new UsageError("the doc-tools template changed shape: cannot find the theme switch");
  html = swap(html, /\s*<div class="toolbar">[^]*?<div class="theme-switch"[^]*?<\/div>\s*<\/div>/, "");
  // The header keeps the title, and on a ticket its number, project, status and dates: an app page, not a document cover.
  html = swap(html, /\s*<p class="lede">[^]*?<\/p>/, "");
  html = swap(html, /\s*<ul class="meta">[^]*?<\/ul>/, meta ? `\n        <ul class="meta">\n          ${meta}\n        </ul>` : "");
  html = swap(html, /\s*<p class="eyebrow">[^]*?<\/p>/, eyebrow ? `\n        <p class="eyebrow">${eyebrow}</p>` : "");
  html = swap(html, "</header>", `  ${themeSwitch[0]}\n    </header>`);
  // The template's own labels are Indonesian; the board speaks English.
  html = swap(html, /<html lang="[a-z-]+"/, '<html lang="en"');
  for (const [from, to] of [['aria-label="Daftar isi"', 'aria-label="Contents"'], ["<p>Isi</p>", "<p>Contents</p>"], ["<summary>Daftar isi</summary>", "<summary>Contents</summary>"],
    ['aria-label="Tema halaman"', 'aria-label="Page theme"'], [">Terang<", ">Light<"], [">Gelap<", ">Dark<"], [">Sistem<", ">System<"]]) html = swap(html, from, to);
  for (const [key, value] of Object.entries({ JUDUL_TAB: tab, JUDUL: title })) html = swap(html, `{{${key}}}`, value);
  // No footer line: on the board nothing sits below the columns, and a ticket ends with its history.
  html = swap(html, /\s*<footer class="doc">[^]*?<\/footer>/, "");
  html = swap(html, "</head>", `<meta name="board-page" content="${esc(page)}">\n<meta name="board-stamp" content="${esc(watch)}">\n${PAGE_STYLE}\n</head>`);
  if (appbar) html = swap(html, "<main>", `<main>\n    <p class="appbar">${appbar}</p>`);
  return swap(html, "</body>", `${PAGE_SCRIPT}\n${WATCH_SCRIPT}\n<!-- ${REPORT_MARK}${stamp ? ` ${stamp}` : ""} -->\n</body>`);
}

/**
 * Builds the board page and the ticket pages that changed into a folder, plus the stamp file open pages watch.
 * Returns what it did; throws without writing anything if a page is not ours to replace or fails the checker.
 */
function buildSite(db, dir, everything) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new UsageError(`the pages go into a folder, and this is a file: ${dir}`);

  const tickets = db.prepare(`${SELECT} ORDER BY t.id DESC`).all().map(rowToTicket);
  const projects = db.prepare("SELECT key, grp FROM projects ORDER BY grp, key").all();

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "board-report-"));
  try {
    const seed = path.join(scratch, "seed.html");
    const made = spawnSync(process.execPath, [DOC_TOOLS, "new", seed], { encoding: "utf8" });
    if (made.status !== 0) throw new UsageError(`doc-tools new failed: ${(made.stdout || "") + (made.stderr || "")}`);
    const template = fs.readFileSync(seed, "utf8");
    fs.rmSync(seed);

    // The board page is rebuilt every time. A ticket page is rebuilt only when what it shows has changed:
    // the ticket itself, the tickets that continue it, or the look of the pages. Each page carries a stamp of
    // those three, so thousands of unchanged tickets cost one file read each instead of a rebuild.
    const build = createHash("sha1").update(template).update(PAGE_STYLE).update(PAGE_SCRIPT).update(WATCH_SCRIPT).digest("hex").slice(0, 12);
    const followersOf = (t) => tickets.filter((other) => other.follows === t.id).map((other) => other.id).sort((a, b) => a - b);
    const stampOf = (t) => `build=${build} updated=${t.updated_at} followers=${followersOf(t).join(",")}`;
    // The board's own stamp moves whenever any ticket or the list of projects does.
    const boardStamp = createHash("sha1").update(build).update(tickets.map((t) => `${t.id}:${stampOf(t)}`).join("|")).update(projects.map((p) => `${p.grp}/${p.key}`).join("|")).digest("hex").slice(0, 16);
    const pages = [["index.html", makePage(template, { tab: "Board", title: "Board", sections: boardSections(tickets, projects), page: "board", watch: boardStamp })]];
    let unchanged = 0;
    for (const t of tickets) {
      const name = `ticket-${t.id}.html`;
      const target = path.join(dir, name);
      const followers = followersOf(t);
      const stamp = stampOf(t);
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      if (current !== null && !current.includes(REPORT_MARK)) throw new UsageError(`refusing to overwrite a file this tool did not write: ${target}`);
      if (!everything && current !== null && current.includes(`<!-- ${REPORT_MARK} ${stamp} -->`)) { unchanged++; continue; }
      pages.push([name, makePage(template, {
        stamp,
        page: String(t.id),
        watch: stamp,
        tab: `#${t.id} ${esc(t.title)}`,
        title: esc(t.title),
        eyebrow: `Ticket #${t.id} · ${esc(t.group)} / ${esc(t.project)} · ${STATUS_LABEL[t.status]}`,
        meta: [t.type ? `<li><b>Type</b> ${esc(t.type)}</li>` : "", t.branch ? `<li><b>Branch</b> <code>${esc(t.branch)}</code></li>` : "",
          ...mergedInto(t).map((branch) => `<li><b>Merged into</b> <code>${esc(branch)}</code></li>`),
          `<li><b>Created</b> ${showDate(t.created_at)}</li>`, `<li><b>Updated</b> ${showDate(t.updated_at)}</li>`].filter(Boolean).join("\n          "),
        appbar: '<a href="index.html">&larr; Back to the board</a>',
        sections: ticketSections(t, followers),
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
    // Written last, so a page that sees the new stamp always finds its new version already in place.
    const stamps = { board: boardStamp, tickets: Object.fromEntries(tickets.map((t) => [String(t.id), stampOf(t)])) };
    fs.writeFileSync(path.join(dir, "stamp.js"), `window.__boardStamp && window.__boardStamp(${JSON.stringify(stamps)});\n`);
    return { dir, written: pages.length - 1, unchanged, projects: projects.length, tickets: tickets.length, waiting: tickets.filter((t) => ["waiting", "review"].includes(columnOf(t))).length };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function cmdReport(args) {
  const out = option(args, "--out");
  const everything = flag(args, "--all");
  const done = buildSite(await openDb(), out ? path.resolve(out) : SITE_DIR, everything);
  console.log(`board written: ${path.join(done.dir, "index.html")}`);
  console.log(`${done.written} ticket page(s) written, ${done.unchanged} unchanged`);
  console.log(`${done.projects} project(s), ${done.tickets} ticket(s), ${done.waiting} need the owner (a question to answer, an agent decision to see, or work to check)`);
  return 0;
}

// Commands that change what the pages show. After each of them the pages beside the board file are brought
// up to date, so nobody has to remember to run "report".
const WRITES = ["project", "add", "approve", "decide", "source", "unverified", "verify", "link", "review", "set", "note", "merged"];

async function refreshPages() {
  try {
    buildSite(await openDb(), SITE_DIR, false);
  } catch (error) {
    // The data is already saved. A page that could not be written must not make the command look failed.
    console.error(`warning: the change is saved, but the pages were not updated (${error.message.split("\n")[0]}); run "report" to see why`);
  }
}

const COMMANDS = { project: cmdProject, add: cmdAdd, approve: cmdApprove, decide: cmdDecide, source: cmdSource, unverified: cmdUnverified, verify: cmdVerify, link: cmdLink, review: cmdReview, set: cmdSet, note: cmdNote, merged: cmdMerged, hook: cmdHook, list: cmdList, show: cmdShow, search: cmdSearch, export: cmdExport, report: cmdReport };
const [command, ...rest] = process.argv.slice(2);
try {
  if (!COMMANDS[command]) throw new UsageError(`usage: board-tools.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
  const action = rest[0];
  process.exitCode = await COMMANDS[command](rest);
  if (process.exitCode === 0 && WRITES.includes(command) && !(command === "project" && action === "list")) await refreshPages();
} catch (error) {
  if (error instanceof Refused) { console.error(`refused:\n${error.message.split("\n").map((l) => `  - ${l}`).join("\n")}`); process.exitCode = 1; }
  else if (error instanceof UsageError) { console.error(`error: ${error.message}`); process.exitCode = 2; }
  else throw error;
}
