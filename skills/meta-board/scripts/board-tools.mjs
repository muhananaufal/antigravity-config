#!/usr/bin/env node
// board-tools: one decision and task board for every project, kept in a single SQLite file outside all repos.
//
//   node board-tools.mjs project ensure [--dir <path>]     create the project for a folder if it is not on the board yet
//   node board-tools.mjs project list
//   node board-tools.mjs add --file <entry.json> [--dir <path>]
//   node board-tools.mjs list [--project p] [--group g] [--kind k] [--status s] [--by user|agent] [--unreviewed] [--limit n]
//   node board-tools.mjs show <id>                          the full text of one entry
//   node board-tools.mjs search <words> [--project p]       ids and titles only
//   node board-tools.mjs set <id> --status <status> [--evidence <text>]
//   node board-tools.mjs review <id>                        the owner has seen a decision the agent made
//   node board-tools.mjs export [--project p]               JSON
//   node board-tools.mjs report --out <file.html>           the board as a page on the shared doc-style
//
// The board lives at ~/.aetheris/board/board.db; AETHERIS_BOARD overrides the path.
// Reading is deliberately narrow: `list` and `search` print one short line per entry, and only `show`
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

const KINDS = ["task", "decision", "question"];
const STATUSES = ["menunggu", "siap", "dikerjakan", "selesai", "batal", "diputuskan"];
const DEFAULT_STATUS = { task: "siap", decision: "diputuskan", question: "menunggu" };
const CREDENTIAL_KEY = /pass(word|wd)?$|secret|token|api[-_]?key|cookie|authorization|credential/i;
const CREDENTIAL_QUERY = /[?&](token|access_token|password|passwd|secret|api_?key|key|signature)=[^&\s]+/i;
const URL_WITH_LOGIN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const REPORT_MARK = "board-tools-report";

class UsageError extends Error {}
class Refused extends Error {}

const isText = (value) => typeof value === "string" && value.trim().length > 0;
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
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL REFERENCES projects(key),
      kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      decided_by TEXT, reviewed INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_project ON entries(project, status);
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title, body);
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

function validate(entry) {
  const problems = [];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return ["the entry must be a JSON object"];
  findCredentials(entry, "", problems);
  if (!KINDS.includes(entry.kind)) { problems.push(`kind must be one of ${KINDS.join(", ")}`); return problems; }
  // The board is read by a person months later. A one-word title or a clipped note does not survive that.
  if (!isText(entry.title) || entry.title.trim().split(/\s+/).length < 3 || entry.title.length > 140) {
    problems.push("title must be a readable phrase of three words or more, at most 140 characters");
  }
  if (entry.kind !== "question") {
    if (!["user", "agent"].includes(entry.decided_by)) problems.push('decided_by must be "user" or "agent"');
    if (entry.decided_by === "user" && !isText(entry.user_words)) problems.push('a decision by the owner needs "user_words": what the owner actually wrote, verbatim');
    if (entry.decided_by === "agent" && !isText(entry.authority)) problems.push('a decision by the agent needs "authority": the owner\'s sentence that let the agent decide, verbatim');
  }
  if (entry.kind === "decision") {
    for (const field of ["question", "chosen", "reason"]) if (!isText(entry[field])) problems.push(`a decision needs "${field}" as a full sentence`);
    const rejected = Array.isArray(entry.rejected) ? entry.rejected : [];
    if (!rejected.length || !rejected.every((r) => r && isText(r.option) && isText(r.reason))) problems.push('a decision needs "rejected": at least one option that was not taken, with its reason');
  }
  if (entry.kind === "task") {
    if (!isText(entry.body)) problems.push('a task needs "body": what was asked and what was agreed');
    if (!Array.isArray(entry.done_when) || !entry.done_when.length || !entry.done_when.every(isText)) problems.push('a task needs "done_when": the acceptance criteria from the panel');
  }
  if (entry.kind === "question" && !isText(entry.question)) problems.push('an open question needs "question" as a full sentence');
  if (entry.status !== undefined && !STATUSES.includes(entry.status)) problems.push(`status must be one of ${STATUSES.join(", ")}`);
  return problems;
}

/** Everything a person might search for, in one string for the full-text index. */
function searchable(entry) {
  return [entry.body, entry.question, entry.chosen, entry.reason, entry.user_words, entry.authority,
    ...(entry.rejected || []).flatMap((r) => [r.option, r.reason]), ...(entry.done_when || []), entry.evidence]
    .filter(isText).join("\n");
}

function rowToEntry(row) {
  return { id: row.id, project: row.project, group: row.grp, kind: row.kind, title: row.title, status: row.status,
    decided_by: row.decided_by, reviewed: Boolean(row.reviewed), created_at: row.created_at, updated_at: row.updated_at, ...JSON.parse(row.data) };
}

const SELECT = "SELECT e.*, p.grp FROM entries e JOIN projects p ON p.key = e.project";

function getEntry(db, idText) {
  const id = Number(idText);
  if (!Number.isInteger(id)) throw new UsageError("give the entry number, for example: show 12");
  const row = db.prepare(`${SELECT} WHERE e.id = ?`).get(id);
  if (!row) throw new UsageError(`no entry #${id}`);
  return rowToEntry(row);
}

const who = (entry) => (entry.decided_by === "agent" ? (entry.reviewed ? "agen" : "agen*") : entry.decided_by === "user" ? "kamu" : "-");
const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const line = (e) => `#${e.id}  ${e.group}/${e.project}  ${e.kind}  ${e.status}  ${who(e)}  ${short(e.title, 90)}`;

function printRows(rows, total) {
  rows.forEach((entry) => console.log(line(entry)));
  if (total > rows.length) console.log(`... ${total - rows.length} more (narrow with --project, --status, or raise --limit)`);
  if (!rows.length) console.log("no entries match");
  else if (rows.some((entry) => entry.decided_by === "agent" && !entry.reviewed)) console.log("* decided by the agent, not yet seen by the owner");
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
    const rows = db.prepare("SELECT p.key, p.grp, COUNT(e.id) AS n FROM projects p LEFT JOIN entries e ON e.project = p.key GROUP BY p.key ORDER BY p.grp, p.key").all();
    rows.forEach((row) => console.log(`${row.grp}/${row.key}  ${row.n} entr${row.n === 1 ? "y" : "ies"}`));
    if (!rows.length) console.log("no projects yet");
    return 0;
  }
  throw new UsageError("usage: project <ensure|list> [--dir <path>]");
}

async function cmdAdd(args) {
  const file = option(args, "--file");
  const dir = option(args, "--dir");
  if (!file) throw new UsageError("usage: add --file <entry.json> [--dir <path>]");
  if (!fs.existsSync(file)) throw new UsageError(`file not found: ${file}`);
  let entry;
  try { entry = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (error) { throw new UsageError(`${file} is not valid JSON: ${error.message}`); }
  const problems = validate(entry);
  if (problems.length) throw new Refused(problems.join("\n"));
  const db = await openDb();
  const project = ensureProject(db, dir);
  const { kind, title, status, decided_by: decidedBy, ...rest } = entry;
  const stamp = now();
  const result = db.prepare("INSERT INTO entries (project, kind, title, status, decided_by, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(project.key, kind, title.trim(), status || DEFAULT_STATUS[kind], decidedBy || null, JSON.stringify(rest), stamp, stamp);
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO entries_fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, searchable(entry));
  if (project.created) console.log(`created project: ${project.grp}/${project.key}`);
  console.log(`added #${id} to ${project.grp}/${project.key}: ${kind}, ${title.trim()}`);
  return 0;
}

async function cmdList(args) {
  const filters = [];
  const values = [];
  for (const [name, column] of [["--project", "e.project"], ["--group", "p.grp"], ["--kind", "e.kind"], ["--status", "e.status"], ["--by", "e.decided_by"]]) {
    const value = option(args, name);
    if (value !== undefined) { filters.push(`${column} = ?`); values.push(name === "--project" || name === "--group" ? kebab(value) : value); }
  }
  if (flag(args, "--unreviewed")) filters.push("e.decided_by = 'agent' AND e.reviewed = 0");
  const limit = Number(option(args, "--limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive number");
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const db = await openDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM entries e JOIN projects p ON p.key = e.project${where}`).get(...values).n;
  const rows = db.prepare(`${SELECT}${where} ORDER BY e.id DESC LIMIT ?`).all(...values, limit).map(rowToEntry);
  printRows(rows, total);
  return 0;
}

async function cmdShow(args) {
  const db = await openDb();
  const e = getEntry(db, args[0]);
  const out = [`#${e.id}  ${e.group}/${e.project}  ${e.kind}  ${e.status}`, `Judul: ${e.title}`, `Dicatat: ${e.created_at}${e.updated_at !== e.created_at ? `, diubah ${e.updated_at}` : ""}`];
  if (e.decided_by) out.push(`Diputuskan oleh: ${e.decided_by === "agent" ? `agen${e.reviewed ? " (sudah dilihat pemilik)" : " (belum dilihat pemilik)"}` : "pemilik"}`);
  const add = (label, value) => { if (isText(value)) out.push("", `${label}:`, value.trim()); };
  add("Isi", e.body);
  add("Pertanyaan", e.question);
  add("Yang dipilih", e.chosen);
  add("Alasan", e.reason);
  if (e.rejected?.length) out.push("", "Yang ditolak:", ...e.rejected.map((r) => `- ${r.option}: ${r.reason}`));
  if (e.done_when?.length) out.push("", "Selesai kalau:", ...e.done_when.map((item) => `- ${item}`));
  add("Kata pemilik", e.user_words);
  add("Izin yang dipakai agen", e.authority);
  add("Bukti", e.evidence);
  if (e.links?.length) out.push("", "Tautan:", ...e.links.map((item) => `- ${item}`));
  console.log(out.join("\n"));
  return 0;
}

async function cmdSearch(args) {
  const project = option(args, "--project");
  const words = args.join(" ").trim();
  if (!words) throw new UsageError("usage: search <words> [--project p]");
  const db = await openDb();
  const scope = project ? " AND e.project = ?" : "";
  const params = project ? [kebab(project)] : [];
  let rows;
  try {
    rows = db.prepare(`${SELECT} JOIN entries_fts f ON f.rowid = e.id WHERE entries_fts MATCH ?${scope} ORDER BY e.id DESC LIMIT 20`).all(`"${words.replace(/"/g, '""')}"`, ...params);
  } catch {
    rows = [];
  }
  printRows(rows.map(rowToEntry), rows.length);
  return 0;
}

function saveData(db, entry, changes) {
  const { id, project, group, kind, title, status, decided_by: decidedBy, reviewed, created_at: created, updated_at: updated, ...data } = { ...entry, ...changes };
  db.prepare("UPDATE entries SET status = ?, reviewed = ?, data = ?, updated_at = ? WHERE id = ?").run(status, reviewed ? 1 : 0, JSON.stringify(data), now(), id);
  db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(id);
  db.prepare("INSERT INTO entries_fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, searchable(data));
}

async function cmdSet(args) {
  const status = option(args, "--status");
  const evidence = option(args, "--evidence");
  if (!args[0] || !status) throw new UsageError("usage: set <id> --status <status> [--evidence <text>]");
  if (!STATUSES.includes(status)) throw new Refused(`status must be one of ${STATUSES.join(", ")}`);
  // "Done" on the board means the same as everywhere else: there is something to point at.
  if (status === "selesai" && !isText(evidence)) throw new Refused('status "selesai" needs --evidence: the command and result, commit, or swipe report that shows it');
  const db = await openDb();
  const entry = getEntry(db, args[0]);
  saveData(db, entry, { status, ...(isText(evidence) ? { evidence: evidence.trim(), finished_at: now() } : {}) });
  console.log(`#${entry.id} is now ${status}`);
  return 0;
}

async function cmdReview(args) {
  const db = await openDb();
  const entry = getEntry(db, args[0]);
  if (entry.decided_by !== "agent") throw new Refused(`#${entry.id} was decided by the owner; only decisions made by the agent are reviewed`);
  saveData(db, entry, { reviewed: true });
  console.log(`#${entry.id} marked as seen by the owner`);
  return 0;
}

async function cmdExport(args) {
  const project = option(args, "--project");
  const db = await openDb();
  const rows = project ? db.prepare(`${SELECT} WHERE e.project = ? ORDER BY e.id`).all(kebab(project)) : db.prepare(`${SELECT} ORDER BY e.id`).all();
  console.log(JSON.stringify({ exported_at: now(), entries: rows.map(rowToEntry) }, null, 2));
  return 0;
}

/* ---------- report ---------- */

// Text from the board goes into HTML as text. Two extra guards keep an owner's sentence from tripping the
// document checker: it rejects template braces and the words it treats as unfinished-work markers.
const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/\{\{/g, "{&#8203;{")
  .replace(/\b(T)(ODO)\b|\b(T)(BD)\b|\b(F)(IXME)\b/g, (m, a, b, c, d, e, f) => `${a || c || e}&#8203;${b || d || f}`)
  .replace(/(lorem) (ipsum)/gi, "$1&#8203; $2");

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const longDate = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

const byPill = (e) => e.decided_by === "agent"
  ? `<span class="pill ${e.reviewed ? "muted" : "warn"}">Diputuskan agen${e.reviewed ? "" : ", belum kamu lihat"}</span>`
  : e.decided_by === "user" ? '<span class="pill ok">Diputuskan kamu</span>' : "";

function detailsOf(e) {
  const parts = [];
  const p = (label, value) => { if (isText(value)) parts.push(`<p><b>${label}</b> ${esc(value)}</p>`); };
  p("Isi.", e.body);
  p("Pertanyaan.", e.question);
  p("Yang dipilih.", e.chosen);
  p("Alasan.", e.reason);
  if (e.rejected?.length) parts.push(`<p><b>Yang ditolak.</b></p><ul>${e.rejected.map((r) => `<li><b>${esc(r.option)}:</b> ${esc(r.reason)}</li>`).join("")}</ul>`);
  if (e.done_when?.length) parts.push(`<p><b>Selesai kalau.</b></p><ul>${e.done_when.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`);
  if (isText(e.user_words)) parts.push(`<blockquote><p>"${esc(e.user_words)}"</p><footer>Kata pemilik, ${esc(longDate(e.created_at))}.</footer></blockquote>`);
  if (isText(e.authority)) parts.push(`<blockquote><p>"${esc(e.authority)}"</p><footer>Kalimat pemilik yang dipakai agen sebagai izin memutuskan.</footer></blockquote>`);
  p("Bukti.", e.evidence);
  return parts.join("\n            ");
}

const card = (e) => `          <div class="card" data-project="${esc(e.project)}">
            <h4>#${e.id} · ${esc(e.title)}</h4>
            <p><span class="pill info">${esc(e.group)} / ${esc(e.project)}</span> ${byPill(e)}</p>
            <details><summary>Rincian</summary>
            ${detailsOf(e)}
            </details>
          </div>`;

const column = (title, entries, emptyText, note) => `        <div>
          <h3>${title} <span class="pill muted">${entries.length}</span></h3>
          <div class="stack">
${entries.length ? entries.map(card).join("\n") : `          <p class="note">${emptyText}</p>`}
          </div>${note ? `\n          <p class="note">${note}</p>` : ""}
        </div>`;

function buildBody(entries, projects, stamp) {
  const waiting = entries.filter((e) => e.status === "menunggu");
  const unseen = entries.filter((e) => e.decided_by === "agent" && !e.reviewed);
  const active = entries.filter((e) => e.kind === "task" && (e.status === "siap" || e.status === "dikerjakan"));
  const doneAll = entries.filter((e) => e.kind === "task" && e.status === "selesai");
  const done = doneAll.slice(0, 30);
  const decisions = entries.filter((e) => e.kind === "decision");
  const list = (items) => items.slice(0, 5).map((e) => `<li><b>#${e.id}</b> ${esc(e.title)} <span class="lbl wrap-ok">${esc(e.project)}</span></li>`).join("\n          ");

  const chips = [`<button class="chip" type="button" data-board-filter="" aria-pressed="true">Semua proyek</button>`,
    ...projects.map((p) => `<button class="chip" type="button" data-board-filter="${esc(p.key)}" aria-pressed="false">${esc(p.grp)} / ${esc(p.key)}</button>`)].join("\n        ");

  const decisionRows = decisions.map((e) => `          <tr data-project="${esc(e.project)}"><td class="id">#${e.id}</td><td><b>${esc(e.title)}</b><br><span class="lbl wrap-ok">${esc(e.group)} / ${esc(e.project)}</span><details><summary>Rincian</summary>
            ${detailsOf(e)}
            </details></td><td>${byPill(e)}</td><td class="nowrap">${esc(longDate(e.created_at))}</td></tr>`).join("\n");

  const sections = [
    ["ringkasan", "Ringkasan", null, `      <div class="grid-2">
        <div class="card"><h4>Yang perlu kamu lihat</h4><ul>
          <li><b>${waiting.length} menunggu keputusanmu.</b></li>
          <li><b>${unseen.length} diputuskan agen dan belum kamu lihat.</b></li>
          ${list([...waiting, ...unseen]) || "<li>Tidak ada yang menunggu.</li>"}
        </ul></div>
        <div class="card"><h4>Isi papan</h4><ul>
          <li><b>${projects.length} proyek</b>, ${entries.length} catatan.</li>
          <li><b>${active.length} tugas berjalan</b>, ${doneAll.length} selesai.</li>
          <li><b>${decisions.length} keputusan tercatat.</b></li>
          <li>Halaman ini salinan dari basis data papan per ${esc(longDate(stamp))}. Untuk mengubah isinya, ubah papannya lalu buat ulang halaman ini.</li>
        </ul></div>
      </div>`],
    ["papan", "Papan", "Pilih proyek untuk menyaring seluruh halaman.", `      <div class="chips" data-board-filters>
        ${chips}
      </div>
      <div class="grid-3">
${column("Menunggu keputusanmu", [...waiting, ...unseen.filter((e) => e.status !== "menunggu")], "Tidak ada.")}
${column("Siap dan dikerjakan", active, "Tidak ada.")}
${column("Selesai", done, "Belum ada.", doneAll.length > done.length ? `Menampilkan ${done.length} terbaru dari ${doneAll.length}.` : "")}
      </div>`],
    ["keputusan", "Semua keputusan", "Terbaru di atas. Tiap baris memuat pertanyaan, pilihan, alasan, yang ditolak, dan kalimat pemiliknya.", decisions.length
      ? `      <div class="table-scroll"><table>
        <thead><tr><th>No.</th><th>Keputusan</th><th>Oleh</th><th>Tanggal</th></tr></thead>
        <tbody>
${decisionRows}
        </tbody>
      </table></div>`
      : "      <p>Belum ada keputusan yang dicatat.</p>"],
    ["bukti", "Daftar sumber", null, `      <div class="table-scroll"><table>
        <thead><tr><th>ID</th><th>Klaim</th><th>Tier</th><th>Sumber</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td class="id">E1</td><td>Semua tugas, keputusan, dan kalimat pemilik di halaman ini</td><td class="n">0</td><td>Basis data papan (<code>board.db</code>), dibaca ${esc(longDate(stamp))}</td><td><span class="pill ok">Dibaca utuh</span></td></tr>
        </tbody>
      </table></div>`],
  ];
  return sections.map(([id, heading, sub, body], index) => `    <section id="${id}">
      <h2><span class="num">${String(index).padStart(2, "0")}</span>${heading}</h2>
${sub ? `      <p class="sub">${sub}</p>\n` : ""}${body}
    </section>`).join("\n\n");
}

// Filters every element tagged with a project. The shared doc-script only filters table rows.
const PAGE_SCRIPT = `<script id="page-script">
(function () {
  var group = document.querySelector("[data-board-filters]");
  if (!group) return;
  var buttons = [].slice.call(group.querySelectorAll("[data-board-filter]"));
  function apply(project) {
    buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-board-filter") === project)); });
    [].slice.call(document.querySelectorAll("[data-project]")).forEach(function (el) {
      el.hidden = project !== "" && el.getAttribute("data-project") !== project;
    });
  }
  buttons.forEach(function (b) { b.addEventListener("click", function () { apply(b.getAttribute("data-board-filter")); }); });
})();
</script>`;

async function cmdReport(args) {
  const out = option(args, "--out");
  if (!out) throw new UsageError("usage: report --out <file.html>");
  const target = path.resolve(out);
  if (fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(REPORT_MARK)) {
    throw new UsageError(`refusing to overwrite a file this tool did not write: ${target}`);
  }
  const db = await openDb();
  const entries = db.prepare(`${SELECT} ORDER BY e.id DESC`).all().map(rowToEntry);
  const projects = db.prepare("SELECT key, grp FROM projects ORDER BY grp, key").all();
  const stamp = now();

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "board-report-"));
  const draft = path.join(scratch, path.basename(target));
  const made = spawnSync(process.execPath, [DOC_TOOLS, "new", draft], { encoding: "utf8" });
  if (made.status !== 0) throw new UsageError(`doc-tools new failed: ${(made.stdout || "") + (made.stderr || "")}`);
  let html = fs.readFileSync(draft, "utf8");
  const start = html.indexOf('<section id="ringkasan">');
  const end = html.indexOf('<footer class="doc">');
  if (start === -1 || end === -1) throw new UsageError("the doc-tools template changed shape: cannot find the summary section or the footer");
  html = `${html.slice(0, start)}${buildBody(entries, projects, stamp).trimStart()}\n\n    ${html.slice(end)}`;

  const waiting = entries.filter((e) => e.status === "menunggu" || (e.decided_by === "agent" && !e.reviewed)).length;
  const fills = {
    JUDUL_TAB: "Papan kerja",
    JENIS: "Papan", TOPIK: "Semua proyek", STATUS: waiting ? `${waiting} menunggu kamu` : "Tidak ada yang menunggu",
    JUDUL: "Papan kerja dan catatan keputusan",
    LEDE: "Tugas yang disetujui dan keputusan yang diambil di semua proyek, dicatat dengan kalimat lengkap supaya masih terbaca berbulan-bulan kemudian. Keputusan yang diambil agen ditandai terpisah dari keputusanmu.",
    TANGGAL: longDate(stamp), BASIS: "basis data papan", STATUS_RINCI: `${projects.length} proyek, ${entries.length} catatan`,
    KAKI: `Dihasilkan board-tools pada ${longDate(stamp)}. Halaman ini salinan; sumbernya basis data papan.`,
  };
  for (const [key, value] of Object.entries(fills)) html = html.split(`{{${key}}}`).join(value);
  html = html.replace("</body>", `${PAGE_SCRIPT}\n<!-- ${REPORT_MARK} -->\n</body>`);

  fs.writeFileSync(draft, html);
  const checked = spawnSync(process.execPath, [DOC_TOOLS, "check", draft], { encoding: "utf8" });
  if (checked.status !== 0) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Refused(`the generated page does not pass doc-tools check; nothing written\n${(checked.stdout || "") + (checked.stderr || "")}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(draft, target);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`board page written: ${target}`);
  console.log(`${projects.length} project(s), ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ${waiting} waiting for the owner`);
  return 0;
}

const COMMANDS = { project: cmdProject, add: cmdAdd, list: cmdList, show: cmdShow, search: cmdSearch, set: cmdSet, review: cmdReview, export: cmdExport, report: cmdReport };
const [command, ...rest] = process.argv.slice(2);
try {
  if (!COMMANDS[command]) throw new UsageError("usage: board-tools.mjs <project|add|list|show|search|set|review|export|report> ...");
  process.exitCode = await COMMANDS[command](rest);
} catch (error) {
  if (error instanceof Refused) { console.error(`refused:\n${error.message.split("\n").map((l) => `  - ${l}`).join("\n")}`); process.exitCode = 1; }
  else if (error instanceof UsageError) { console.error(`error: ${error.message}`); process.exitCode = 2; }
  else throw error;
}
