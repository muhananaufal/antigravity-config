#!/usr/bin/env node
// Tests for board-tools. Every run uses a throwaway database, never the real board.
//
//   node board-tools.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "board-tools.mjs");
const DOC_TOOLS = path.join(HERE, "..", "..", "meta-prd", "scripts", "doc-tools.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "board-tools-test-"));
const DB = path.join(TMP, "board.db");

// Two project folders under two groups, the way the owner's disk is laid out.
const HRIS = path.join(TMP, "kantor", "hris-demo");
const BLOG = path.join(TMP, "personal", "Blog Pribadi");
fs.mkdirSync(HRIS, { recursive: true });
fs.mkdirSync(BLOG, { recursive: true });

function tool(args, { now = "2026-11-10T09:00:00+07:00" } = {}) {
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], {
    encoding: "utf8",
    cwd: TMP,
    env: { ...process.env, AETHERIS_BOARD: DB, BOARD_NOW: now },
  });
  return { code: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

let counter = 0;
function file(data) {
  const name = path.join(TMP, `input-${++counter}.json`);
  fs.writeFileSync(name, JSON.stringify(data, null, 2));
  return name;
}

let failures = 0;
function expect(name, condition, detail) {
  if (condition) console.log(`ok    ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).trim().split("\n").slice(0, 8).join("\n      ")}` : ""}`); }
}
const count = (text) => (text.match(/^[a-z0-9][a-z0-9-]*-\d+ {2}/gm) || []).length;
const keyOf = (text) => (/added ([a-z0-9][a-z0-9-]*-\d+) /.exec(text) || [])[1];
const numOf = (key) => Number(String(key).split("-").pop());
// data.js and stamp.js are "window.__x && window.__x({...});": the JSON sits between the second call and the end.
const payload = (text, name) => JSON.parse(text.slice(text.indexOf(`${name}(`) + name.length + 1, text.lastIndexOf(");")));
const loadData = (dir) => payload(fs.readFileSync(path.join(dir, "data.js"), "utf8"), "__boardData");

// What the owner and the agent write stays in the language they wrote it in; only the tool speaks English.
const LONG = "Batas klaim dihitung per duty, bukan per klaim, supaya Field Duty lima hari tetap bisa diklaim penuh. Kalimat ini sengaja panjang dan lengkap, dan harus tersimpan apa adanya tanpa dipendekkan.";

const ownerDecision = () => ({
  question: "Batas tiga per bulan itu menghitung klaim atau duty?",
  chosen: "Dihitung per duty.",
  reason: LONG,
  rejected: [{ option: "Dihitung per klaim", reason: "Field Duty lebih dari tiga hari tidak bisa diklaim penuh." }],
  decided_by: "user",
  user_words: "per duty aja ya, biar yang dinas panjang ngga kepotong <b>ya</b>",
});

const agentDecision = () => ({
  question: "Angka tiga disimpan di mana?",
  chosen: "Sebagai konstanta di ReimburseService, seperti batas lima foto struk.",
  reason: "Pemilik tidak meminta angka yang bisa diatur, dan modul ini sudah memakai pola konstanta.",
  rejected: [{ option: "Kolom pengaturan per perusahaan", reason: "Butuh migrasi dan layar baru yang tidak diminta." }],
  decided_by: "agent",
  authority: "pakai bawaanmu saja untuk yang kecil-kecil",
});

const pendingDecision = () => ({ question: "Apakah batasnya berlaku juga untuk klaim yang ditolak?" });

const ticket = () => ({
  title: "Batas tiga duty yang diklaim per karyawan per bulan",
  summary: "Karyawan hanya bisa mengajukan reimburse transport untuk tiga duty dalam satu bulan. Duty keempat ditolak dengan pesan yang menjelaskan batasnya.",
  body: "Permintaan pemilik: tambahkan batas reimburse transport. Panel disetujui dengan batas dihitung per duty.",
  done_when: ["Karyawan dengan tiga duty yang sudah diklaim melihat pesan batas saat mengajukan duty keempat.", "Klaim kedua pada duty yang sama tetap tersimpan."],
  decisions: [ownerDecision()],
  sources: [{ claim: "Klaim disimpan per foto struk, bukan per duty", source: "app/Services/ReimburseService.php:88", status: "read in full" }],
  approved_by: "user",
  user_words: "gass",
  // These folders are not git repositories, so the type is stated instead of derived from a branch.
  type: "feature",
});

// --- projects are created on first use -----------------------------------------------------------
{
  const first = tool(["project", "ensure", "--dir", HRIS]);
  expect("project: created from the folder name and its parent", first.code === 0 && /kantor\/hris-demo/.test(first.text) && /created/.test(first.text), first.text);
  const again = tool(["project", "ensure", "--dir", HRIS]);
  expect("project: second call does not create a duplicate", again.code === 0 && /exists/.test(again.text), again.text);
}

// --- adding tickets ------------------------------------------------------------------------------
let id = null, idBlog = null;
{
  const a = tool(["add", "--file", file(ticket()), "--dir", HRIS]);
  id = keyOf(a.text);
  expect("add: ticket with summary, decision and source", a.code === 0 && id, a.text);
  const b = tool(["add", "--file", file({ ...ticket(), title: "Tema blog memakai huruf serif", decisions: [], user_words: "serif aja" }), "--dir", BLOG], { now: "2026-10-02T08:00:00+07:00" });
  idBlog = keyOf(b.text);
  expect("add: unknown project is created on the way, key made kebab-case; decisions may be empty", b.code === 0 && /personal\/blog-pribadi/.test(b.text), b.text);
}

const REJECTED = [
  ["ticket without summary", (t) => { delete t.summary; }, /summary/],
  ["summary that is only a few words", (t) => { t.summary = "batas klaim"; }, /summary/],
  ["ticket without done_when", (t) => { t.done_when = []; }, /done_when/],
  ["ticket without sources", (t) => { t.sources = []; }, /sources/],
  ["source without where it comes from", (t) => { delete t.sources[0].source; }, /sources\[0\]/],
  ["ticket approved by the owner without the owner's words", (t) => { delete t.user_words; }, /user_words/],
  ["ticket created by the agent without the sentence that allowed it", (t) => { t.approved_by = "agent"; delete t.user_words; }, /authority/],
  ["owner decision without the owner's words", (t) => { delete t.decisions[0].user_words; }, /decisions\[0\].*user_words/],
  ["agent decision without the sentence that allowed it", (t) => { t.decisions[0] = agentDecision(); delete t.decisions[0].authority; }, /decisions\[0\].*authority/],
  ["decision without rejected options", (t) => { t.decisions[0].rejected = []; }, /rejected/],
  ["decision without a reason", (t) => { t.decisions[0].reason = " "; }, /reason/],
  ["unknown decided_by", (t) => { t.decisions[0].decided_by = "ai"; }, /decided_by/],
  ["password key", (t) => { t.password = "rahasia"; }, /must not store credentials/],
  ["token in text", (t) => { t.body = "panggil https://x.test/api?token=abc123 dulu"; }, /credential in a query string/],
  ["title too short to be read by a person", (t) => { t.title = "klaim"; }, /title/],
  ["a new ticket that starts as done", (t) => { t.status = "done"; }, /reached with "set"/],
  ["a status from the old vocabulary", (t) => { t.status = "siap"; }, /status must be one of/],
  ["ticket without a type in a folder without git", (t) => { delete t.type; }, /"type"/],
  ["a type that is not on the list", (t) => { t.type = "urgent"; }, /type must be one of/],
  ["a branch in a folder that is not a git repository", (t) => { t.branch = "feature/claim-limit"; }, /not a git repository/],
  ["free-form tags", (t) => { t.tags = ["reimburse"]; }, /tags/],
];
for (const [name, mutate, pattern] of REJECTED) {
  const data = ticket();
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) { failures++; console.log(`NOT APPLIED  ${name}`); continue; }
  const r = tool(["add", "--file", file(data), "--dir", HRIS]);
  expect(`add rejects: ${name}`, r.code === 1 && pattern.test(r.text), r.text);
}

// --- decisions and sources live inside the ticket ------------------------------------------------
{
  const a = tool(["decide", id, "--file", file(agentDecision())]);
  expect("decide: appends a decision made by the agent", a.code === 0 && /K2/.test(a.text), a.text);
  const p = tool(["decide", id, "--file", file(pendingDecision())]);
  expect("decide: a question without an answer is stored as waiting", p.code === 0 && /K3/.test(p.text) && /waiting/.test(p.text), p.text);
  const bad = tool(["decide", id, "--file", file({ ...ownerDecision(), rejected: [] })]);
  expect("decide: an incomplete decision is refused", bad.code === 1 && /rejected/.test(bad.text), bad.text);
  const none = tool(["decide", "kantor-hris-demo-999", "--file", file(agentDecision())]);
  expect("decide: a decision cannot exist without its ticket", none.code === 2 && /no ticket kantor-hris-demo-999/.test(none.text), none.text);
  const bare = tool(["show", "1"]);
  expect("show: a number alone is refused and the full key is asked for", bare.code === 2 && /full ticket key/.test(bare.text) && /kantor-hris-demo-1/.test(bare.text), bare.text);
  expect("add: tickets are numbered per project and known by a key with the parent folder", id === "kantor-hris-demo-1" && idBlog === "personal-blog-pribadi-1", `${id} ${idBlog}`);
  const s = tool(["source", id, "--file", file({ claim: "Batas lima foto struk ditulis sebagai konstanta", source: "app/Services/ReimburseService.php:14", status: "read in full" })]);
  expect("source: appends a source", s.code === 0 && /E2/.test(s.text), s.text);

  const shown = tool(["show", id]);
  expect("show: summary, decisions and sources are all inside the ticket",
    shown.code === 0 && /^Summary:/m.test(shown.text) && /^Decisions:/m.test(shown.text) && /^Sources:/m.test(shown.text)
    && /K1/.test(shown.text) && /K2/.test(shown.text) && /K3/.test(shown.text) && /E2/.test(shown.text), shown.text);
  expect("show: full text comes back unchanged", shown.text.includes(LONG) && shown.text.includes("per duty aja ya, biar yang dinas panjang ngga kepotong <b>ya</b>") && /Dihitung per klaim/.test(shown.text), shown.text);
}

// --- reading stays small -------------------------------------------------------------------------
{
  const all = tool(["list"]);
  const rows = all.text.split("\n").filter((line) => /^[a-z0-9][a-z0-9-]*-\d+ {2}/.test(line));
  expect("list: one short line per ticket", all.code === 0 && rows.length === 2 && rows.every((line) => line.length < 200), all.text);
  expect("list: never prints the long text", !all.text.includes("sengaja panjang"), all.text);
  const one = tool(["list", "--project", "hris-demo"]);
  expect("list: project filter isolates", count(one.text) === 1 && !/Tema blog/.test(one.text), one.text);
  const group = tool(["list", "--group", "personal"]);
  expect("list: group filter", count(group.text) === 1 && /Tema blog/.test(group.text), group.text);
  const limited = tool(["list", "--limit", "1"]);
  expect("list: limit is applied and the remainder is announced", count(limited.text) === 1 && /1 more/.test(limited.text), limited.text);
  const since = tool(["list", "--created-from", "2026-11-01"]);
  expect("list: created-from keeps only newer tickets", count(since.text) === 1 && !/Tema blog/.test(since.text), since.text);
  const until = tool(["list", "--updated-to", "2026-10-31"]);
  expect("list: updated-to keeps only older tickets", count(until.text) === 1 && /Tema blog/.test(until.text), until.text);
  const badDate = tool(["list", "--created-from", "kemarin"]);
  expect("list: a date that is not YYYY-MM-DD is refused", badDate.code === 2 && /YYYY-MM-DD/.test(badDate.text), badDate.text);
  const found = tool(["search", "konstanta"]);
  expect("search: a word from a decision leads to its ticket", found.code === 0 && new RegExp(`^${id}\\b`, "m").test(found.text) && !found.text.includes("sengaja panjang"), found.text);
  const scoped = tool(["search", "serif", "--project", "hris-demo"]);
  expect("search: respects the project filter", scoped.code === 0 && count(scoped.text) === 0, scoped.text);
}

// --- waiting for the owner -----------------------------------------------------------------------
{
  const waiting = tool(["list", "--waiting"]);
  expect("waiting: lists the ticket with an unanswered question and an unseen agent decision", count(waiting.text) === 1 && new RegExp(`^${id}\\b`, "m").test(waiting.text), waiting.text);
  const wrong = tool(["review", id, "K1"]);
  expect("review: only applies to decisions made by the agent", wrong.code === 1 && /decided by the owner/.test(wrong.text), wrong.text);
  const seen = tool(["review", id, "K2"]);
  expect("review: marks an agent decision as seen", seen.code === 0, seen.text);
  const still = tool(["list", "--waiting"]);
  expect("waiting: still listed while a question is unanswered", count(still.text) === 1, still.text);
  const answered = tool(["decide", id, "--answers", "K3", "--file", file({ ...ownerDecision(), question: pendingDecision().question, chosen: "Tidak, klaim yang ditolak tidak dihitung.", user_words: "yang ditolak jangan dihitung" })]);
  expect("decide --answers: fills in the waiting question", answered.code === 0, answered.text);
  const after = tool(["list", "--waiting"]);
  expect("waiting: empty once answered and reviewed", count(after.text) === 0, after.text);
  const shown = tool(["show", id]);
  expect("show: the answer replaced the waiting question in place", /K3[^\n]*\n[^]*yang ditolak jangan dihitung/.test(shown.text) && !/K4/.test(shown.text), shown.text);
}

// --- status needs evidence, and done needs the owner ---------------------------------------------
{
  const EVIDENCE = "php artisan test: 412 lulus, 0 gagal; commit a1b2c3d";
  const doing = tool(["set", id, "--status", "doing"]);
  expect("set: in progress needs nothing extra", doing.code === 0, doing.text);
  const bare = tool(["set", id, "--status", "review"]);
  expect("set: handing over for checking without evidence is refused", bare.code === 1 && /evidence/.test(bare.text), bare.text);
  const noWords = tool(["set", id, "--status", "done", "--evidence", EVIDENCE]);
  expect("set: done without the owner's acceptance is refused", noWords.code === 1 && /--words/.test(noWords.text), noWords.text);
  const check = tool(["set", id, "--status", "review", "--evidence", EVIDENCE], { now: "2026-11-12T15:00:00+07:00" });
  const waiting = tool(["list", "--waiting"]);
  expect("set: a ticket with evidence waits for the owner to check it", check.code === 0 && count(waiting.text) === 1, check.text + waiting.text);
  const lazyReturn = tool(["set", id, "--status", "doing"]);
  expect("set: sending back without a reason is refused", lazyReturn.code === 1 && /--reason/.test(lazyReturn.text), lazyReturn.text);
  const back = tool(["set", id, "--status", "doing", "--reason", "Pesan batas belum muncul di aplikasi HP.", "--words", "di hp pesannya belum keluar"], { now: "2026-11-13T09:00:00+07:00" });
  const listed = tool(["list", "--project", "hris-demo"]);
  expect("set: sent back to the same ticket, and the list says so", back.code === 0 && /sent back/.test(back.text) && /sent back 1x/.test(listed.text), back.text + listed.text);
  tool(["set", id, "--status", "review", "--evidence", `${EVIDENCE}; pesan muncul di HP`], { now: "2026-11-14T10:00:00+07:00" });
  const done = tool(["set", id, "--status", "done", "--words", "oke sudah muncul"], { now: "2026-11-14T16:00:00+07:00" });
  const shown = tool(["show", id]);
  expect("set: accepted by the owner, with the whole trail in the history", done.code === 0 && /^History:/m.test(shown.text) && /2026-11-13: review to doing \(sent back\)/.test(shown.text)
    && /di hp pesannya belum keluar/.test(shown.text) && /2026-11-14: review to done/.test(shown.text) && /oke sudah muncul/.test(shown.text), shown.text);
  const bad = tool(["set", id, "--status", "beres"]);
  expect("set: unknown status is refused", bad.code === 1 && /status must be one of/.test(bad.text), bad.text);
  const cancel = tool(["set", idBlog, "--status", "cancelled"]);
  expect("set: cancelling without a reason is refused", cancel.code === 1 && /--reason/.test(cancel.text), cancel.text);
}

// --- ideas, and follow-up tickets ----------------------------------------------------------------
let idIdea = null, idNext = null;
{
  const idea = { title: "Ekspor rekap klaim ke Excel", summary: "Bagian keuangan ingin mengunduh rekap klaim reimburse per bulan sebagai berkas Excel untuk dicocokkan dengan pembukuan.", status: "idea" };
  const a = tool(["add", "--file", file(idea), "--dir", HRIS]);
  idIdea = keyOf(a.text);
  expect("idea: recorded with only a title and a summary", a.code === 0 && idIdea, a.text);
  const skip = tool(["set", idIdea, "--status", "doing"]);
  expect("idea: cannot be worked on before it is approved", skip.code === 1 && /approve/.test(skip.text), skip.text);
  const thin = tool(["approve", idIdea, "--file", file({ approved_by: "user", user_words: "gass" })]);
  expect("approve: refused without acceptance criteria and sources", thin.code === 1 && /done_when/.test(thin.text) && /sources/.test(thin.text), thin.text);
  const untyped = tool(["approve", idIdea, "--file", file({ done_when: ticket().done_when, sources: ticket().sources, approved_by: "user", user_words: "gass yang excel" })]);
  expect("approve: refused without a type", untyped.code === 1 && /"type"/.test(untyped.text), untyped.text);
  const ok = tool(["approve", idIdea, "--file", file({ done_when: ticket().done_when, sources: ticket().sources, approved_by: "user", user_words: "gass yang excel", type: "feature" })]);
  const listed = tool(["list", "--status", "ready"]);
  expect("approve: the idea becomes ready work", ok.code === 0 && new RegExp(`^${idIdea}\\b`, "m").test(listed.text), ok.text + listed.text);
  const twice = tool(["approve", idIdea, "--file", file({ approved_by: "user", user_words: "gass" })]);
  expect("approve: only an idea is approved", twice.code === 1 && /not an idea/.test(twice.text), twice.text);

  const next = tool(["add", "--file", file({ ...ticket(), title: "Batas klaim bisa diatur per perusahaan", decisions: [], follows: numOf(id) }), "--dir", HRIS]);
  idNext = keyOf(next.text);
  const older = tool(["show", id]);
  const newer = tool(["show", idNext]);
  expect("follows: changed criteria are a new ticket, linked both ways", next.code === 0 && new RegExp(`Continued by: ${idNext}`).test(older.text) && new RegExp(`Follows: ${id}`).test(newer.text), next.text);
  const byKey = tool(["add", "--file", file({ ...ticket(), follows: id }), "--dir", HRIS]);
  expect("follows: takes the number within the project, not a key", byKey.code === 1 && /"follows" must be the number/.test(byKey.text), byKey.text);
  const ghost = tool(["add", "--file", file({ ...ticket(), follows: 999 }), "--dir", HRIS]);
  expect("follows: refused when the earlier ticket does not exist", ghost.code === 1 && /does not exist/.test(ghost.text), ghost.text);
  tool(["set", idBlog, "--status", "cancelled", "--reason", "Blognya tidak jadi dibuat."], { now: "2026-10-05T08:00:00+07:00" });

  // A progress note records where the work stands without moving the ticket.
  const terse = tool(["note", idNext, "--text", "lanjut"]);
  expect("note: a note too short to help the next session is refused", terse.code === 1 && /--text/.test(terse.text), terse.text);
  const noted = tool(["note", idNext, "--text", "Migrasi kolom batas sudah ditulis dan lulus. Berikutnya: layar pengaturan per perusahaan."], { now: "2026-11-15T17:00:00+07:00" });
  const afterNote = tool(["show", idNext]);
  expect("note: stored in the history, status unchanged", noted.code === 0 && /2026-11-15: note: Migrasi kolom batas/.test(afterNote.text) && /^\S+-\d+\s+\S+\s+ready/m.test(afterNote.text), noted.text + afterNote.text);
}

// --- export and the one page --------------------------------------------------------------------
{
  const exported = tool(["export", "--project", "hris-demo"]);
  let parsed = null;
  try { parsed = JSON.parse(exported.text); } catch { /* reported below */ }
  expect("export: a folder name finds its project; decisions nested in the ticket, which carries its key", parsed !== null && parsed.tickets.length === 3 && parsed.tickets[0].decisions.length === 3 && parsed.tickets[0].key === id, exported.text.slice(0, 300));

  const site = path.join(TMP, "manual-site"); // not the folder the tool keeps up to date by itself
  const r = tool(["report", "--out", site]);
  const index = path.join(site, "index.html");
  expect("report: one page, one data file and one stamp file, nothing per ticket", r.code === 0 && fs.existsSync(site) && fs.readdirSync(site).sort().join(",") === "data.js,index.html,stamp.js", r.text);
  if (fs.existsSync(index)) {
    const shell = fs.readFileSync(index, "utf8");
    const data = loadData(site);
    const board = data.filters + data.board;
    const view = data.tickets[id];
    const detail = view.body;
    const bodyOf = (html) => html.slice(html.indexOf("<body"));
    const check = spawnSync(process.execPath, [DOC_TOOLS, "check", index], { encoding: "utf8" });
    expect("report: the page passes doc-tools check", check.status === 0, (check.stdout || "") + (check.stderr || ""));
    expect("report: every ticket is in the data under its key", Object.keys(data.tickets).sort().join(",") === [id, idIdea, idNext, idBlog].sort().join(","), Object.keys(data.tickets).join(","));
    expect("report: board cards open their ticket by key and carry the project for filtering", board.includes(`href="#${id}"`) && board.includes('data-project="kantor-hris-demo"') && board.includes('data-project="personal-blog-pribadi"'));
    expect("report: the board does not carry ticket details", !board.includes("sengaja panjang"));
    const columns = [...board.matchAll(/<h3>([^<]+) <span class="pill muted" data-count>(\d+)<\/span>/g)].map((m) => `${m[1]}=${m[2]}`).join(", ");
    expect("report: seven columns, cancelled after done, each ticket in the right one", columns === "Idea=0, Waiting for you=0, Ready=2, In progress=0, Needs your check=0, Done=1, Cancelled=1", columns);
    expect("report: cards carry created and updated dates, shown and as data for the range filter",
      new RegExp(`href="#${id}"[^>]*data-created="2026-11-10"[^>]*data-updated="2026-11-14"`).test(board) && /Created 10 Nov 2026/.test(board) && /Updated 14 Nov 2026/.test(board));
    expect("report: the board has a date range picker for created or updated", /data-date-field="created"/.test(board) && /data-date-field="updated"/.test(board) && /<dialog[^>]*data-range/.test(board) && /data-range-preset="last7"/.test(board));
    const filterRow = (/<div class="filters"[^]*?<dialog/.exec(board) || [""])[0];
    expect("report: project picker, title search and date range sit in one filter row; the date field lives in the dialog",
      /data-project-picker/.test(filterRow) && /data-project-search/.test(filterRow) && /data-title-search/.test(filterRow) && !/data-date-field/.test(filterRow) && /data-range-open/.test(filterRow)
      && filterRow.indexOf("data-project-picker") < filterRow.indexOf("data-title-search") && (board.match(/class="filters"/g) || []).length === 1, filterRow.slice(0, 400));
    expect("report: the filter row offers a sort field and a direction", !/<select/.test(filterRow) && /data-sort-picker/.test(filterRow) && ["updated", "created", "title", "number"].every((v) => filterRow.includes(`role="option" data-sort-option="${v}"`)) && /data-sort-dir/.test(filterRow));
    expect("report: every column can show more and less, and cards carry what sorting needs", (board.match(/data-more hidden/g) || []).length === 7 && (board.match(/data-less hidden/g) || []).length === 7
      && new RegExp(`data-key="${id}" data-num="1" data-ct="\\d+" data-ut="\\d+"`).test(board));
    expect("report: the project picker lists every project by key, labelled with group and folder", /role="option"[^>]*data-board-filter="kantor-hris-demo"[^>]*>kantor \/ hris-demo</.test(board) && /role="option"[^>]*data-board-filter="personal-blog-pribadi"/.test(board));
    expect("report: the page's headings are kept for screen readers only", (shell.match(/<section id="[a-z]+" class="bare"( hidden)?>/g) || []).length === 3 && /section\.bare > h2\s*{[^}]*clip-path/.test(shell));
    expect("report: cards show the ticket type", /<span class="pill solid">feature<\/span>/.test(board));
    expect("report: the board scrolls inside its own box instead of stacking, with pinned column headings", /\.board\s*{[^}]*overflow:\s*auto[^}]*min-height:\s*0/.test(shell) && /\.board h3\s*{[^}]*position:\s*sticky/.test(shell) && !/class="grid-3"/.test(board));
    expect("report: board card marks a ticket that was sent back", /Sent back 1×/.test(board));
    expect("report: ticket view has summary, decisions, sources and history", /id="summary"/.test(detail) && /id="decisions"/.test(detail) && /id="sources"/.test(detail) && /id="history"/.test(detail)
      && detail.includes("sengaja panjang dan lengkap") && detail.includes("ReimburseService.php:14") && /Sent back to In progress/.test(detail));
    expect("report: the page has no footer line", !/<footer class="doc"/.test(shell) && !/Generated \d/.test(bodyOf(shell)));
    expect("report: ticket header shows its key, the type, and when it was created and updated", view.eyebrow.startsWith(`Ticket ${id} · kantor / hris-demo`) && /<b>Type<\/b> feature/.test(view.meta) && /<b>Created<\/b> 10 Nov 2026/.test(view.meta) && /<b>Updated<\/b> 14 Nov 2026/.test(view.meta));
    expect("report: a progress note appears in the ticket history", /Progress note/.test(data.tickets[idNext].body) && /Migrasi kolom batas sudah ditulis/.test(data.tickets[idNext].body));
    expect("report: the page has a way back to the board, and a ticket links on to its follow-up", /<p class="appbar" data-slot="appbar" hidden><a href="#board">/.test(shell) && detail.includes(`href="#${idNext}"`));
    expect("report: owner's words are escaped, not interpreted", detail.includes("&lt;b&gt;ya&lt;/b&gt;") && !detail.includes("<b>ya</b>"));
    expect("report: shows who decided", /Decided by you/.test(detail) && /Decided by the agent/.test(detail));
    expect("report: no sidebar, no cover text, theme switch inside the header, ticket slots empty until a ticket is open",
      /nav\.toc[^}]*display:\s*none/.test(shell) && !/class="lede"|class="sub"|class="toolbar"/.test(bodyOf(shell)) && /<header class="doc">[^]*data-theme-set="dark"[^]*<\/header>/.test(shell)
      && /<p class="eyebrow" data-slot="eyebrow" hidden><\/p>/.test(shell) && /<ul class="meta" data-slot="meta" hidden><\/ul>/.test(shell));
    const visible = (html) => html.replace(/<script[^]*?<\/script>/g, "").replace(/<blockquote>[^]*?<\/blockquote>/g, "");
    const shown = visible(bodyOf(shell)) + visible(board) + visible(detail);
    expect("report: the page speaks English", /<html[^>]*lang="en"/.test(shell) && !/Terang|Gelap|Sistem|Ringkasan|Keputusan|Daftar|Selesai|Riwayat|Tiket|Papan|Diputuskan/.test(shown), (/(Terang|Gelap|Sistem|Ringkasan|Keputusan|Daftar|Selesai|Riwayat|Tiket|Papan|Diputuskan)[^<]{0,40}/.exec(shown) || [])[0]);

    // The page only changes with the tool; the data is rewritten every time.
    const mark = fs.statSync(index).mtimeMs;
    const again = tool(["report", "--out", site]);
    expect("report: the page itself is not rewritten when only the data changes", again.code === 0 && /page unchanged/.test(again.text) && fs.statSync(index).mtimeMs === mark, again.text);
    const full = tool(["report", "--out", site, "--all"]);
    expect("report --all: rewrites the page too", /page written/.test(full.text) && fs.statSync(index).mtimeMs > mark, full.text);

    const before = loadData(site).stamps;
    const followUp = tool(["add", "--file", file({ ...ticket(), title: "Batas klaim untuk karyawan kontrak", decisions: [], follows: numOf(id) }), "--dir", HRIS]);
    const newKey = keyOf(followUp.text);
    tool(["report", "--out", site]);
    const after = loadData(site);
    expect("report: a new follow-up changes the stamp of the ticket it continues, which now links to it", newKey === "kantor-hris-demo-4" && after.stamps.tickets[id] !== before.tickets[id] && after.stamps.tickets[idBlog] === before.tickets[idBlog] && after.tickets[id].body.includes(`href="#${newKey}"`), newKey);

    fs.writeFileSync(path.join(site, "ticket-1.html"), "<p>a page from before</p><!-- board-tools-report -->");
    fs.writeFileSync(path.join(site, "ticket-2.html"), "<p>someone else's file</p>");
    tool(["report", "--out", site]);
    expect("report: pages left from one-page-per-ticket are cleared, other files are left alone", !fs.existsSync(path.join(site, "ticket-1.html")) && fs.existsSync(path.join(site, "ticket-2.html")));
    fs.writeFileSync(path.join(site, "data.js"), "// not ours");
    const foreign = tool(["report", "--out", site]);
    expect("report: refuses to overwrite a file it did not write", foreign.code === 2 && /did not write/.test(foreign.text), foreign.text);
  }
}

// --- what was left out, what is still a guess, and where the related documents are ---------------
{
  const full = () => ({
    ...ticket(),
    title: "Ekspor rekap klaim per bulan",
    decisions: [],
    out_of_scope: ["Ekspor ke PDF tidak dikerjakan; keuangan hanya meminta Excel."],
    unverified: [{ claim: "Pustaka Excel yang terpasang bisa menulis lebih dari 10.000 baris tanpa habis memori.", check: "Jalankan ekspor dengan data uji 20.000 baris dan lihat pemakaian memorinya." }],
    links: [{ label: "PRD ekspor klaim", target: "docs/claims-export-prd.html" }],
  });
  for (const [name, mutate, pattern] of [
    ["out_of_scope that is not a list of sentences", (t) => { t.out_of_scope = [""]; }, /out_of_scope/],
    ["a guess without a way to check it", (t) => { delete t.unverified[0].check; }, /unverified\[0\]/],
    ["a link without a target", (t) => { delete t.links[0].target; }, /links\[0\]/],
  ]) {
    const data = full();
    mutate(data);
    const r = tool(["add", "--file", file(data), "--dir", BLOG]);
    expect(`add rejects: ${name}`, r.code === 1 && pattern.test(r.text), r.text);
  }
  const added = tool(["add", "--file", file(full()), "--dir", BLOG]);
  const x = keyOf(added.text);
  const shown = tool(["show", x]);
  expect("show: out of scope, not yet verified and links are part of the ticket", added.code === 0 && /^Out of scope:\n- Ekspor ke PDF/m.test(shown.text) && /^Not yet verified:\nU1 \(open\): Pustaka Excel/m.test(shown.text) && /How to check: Jalankan ekspor/.test(shown.text) && /^Links:\nL1: PRD ekspor klaim \| docs\/claims-export-prd\.html/m.test(shown.text), shown.text);
  expect("list: a ticket with an open guess says so", /1 unverified/.test(tool(["list", "--project", "blog-pribadi"]).text));

  tool(["set", x, "--status", "doing"]);
  const early = tool(["set", x, "--status", "review", "--evidence", "ekspor 500 baris berhasil"]);
  expect("set review: refused while a guess is still unchecked", early.code === 1 && /U1/.test(early.text) && /verify/.test(early.text), early.text);
  const empty = tool(["verify", x, "U1"]);
  expect("verify: refused without saying what was found", empty.code === 1 && /--result/.test(empty.text), empty.text);
  const checked = tool(["verify", x, "U1", "--result", "Ekspor 20.000 baris selesai dengan memori puncak 180 MB."], { now: "2026-11-17T10:00:00+07:00" });
  const twice = tool(["verify", x, "U1", "--result", "sekali lagi"]);
  expect("verify: records the result once", checked.code === 0 && twice.code === 1 && /already/.test(twice.text) && /U1 \(checked 2026-11-17\)[^\n]*\n[^]*memori puncak 180 MB/.test(tool(["show", x]).text), checked.text + twice.text);
  const later = tool(["unverified", x, "--file", file({ claim: "Keuangan membuka berkasnya dengan Excel versi lama.", check: "Tanyakan versi Excel yang dipakai bagian keuangan." })]);
  expect("unverified: a new guess can be added while the work is under way", later.code === 0 && /U2/.test(later.text), later.text);
  tool(["verify", x, "U2", "--result", "Keuangan memakai Excel 2019."]);
  const ready = tool(["set", x, "--status", "review", "--evidence", "ekspor 20.000 baris berhasil"]);
  expect("set review: accepted once every guess has been checked", ready.code === 0, ready.text);
  const link = tool(["link", x, "--label", "Laporan swipe ekspor", "--target", ".swipe/reports/2026-11-17-export.html"]);
  const badLink = tool(["link", x, "--label", "Laporan"]);
  expect("link: adds a related document, and needs both a label and a target", link.code === 0 && /L2/.test(link.text) && badLink.code !== 0, link.text + badLink.text);

  const site2 = path.join(TMP, "site2");
  tool(["report", "--out", site2]);
  const page = loadData(site2).tickets[x].body;
  const order = [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]).join(",");
  expect("report: the ticket page shows the three sections in a fixed order", order === "summary,decisions,done-when,out-of-scope,unverified,sources,links,history", order);
  expect("report: a checked guess shows its result, and links are listed", /Checked/.test(page) && page.includes("memori puncak 180 MB") && page.includes("Laporan swipe ekspor") && page.includes(".swipe/reports/2026-11-17-export.html"));
  const plain = loadData(site2).tickets[id].body;
  expect("report: a ticket without them shows no empty sections", !/id="out-of-scope"|id="unverified"|id="links"/.test(plain));
  const open = tool(["add", "--file", file({ ...full(), title: "Impor karyawan dari Excel" }), "--dir", BLOG]);
  tool(["report", "--out", site2]);
  expect("report: the board card marks a ticket with an open guess", open.code === 0 && /1 to verify/.test(loadData(site2).board));
}

// --- the page follows the data by itself -----------------------------------------------------------
{
  // The page lives in a "site" folder beside the board file, so a throwaway board never touches the real one.
  const auto = path.join(TMP, "site");
  const stamps = () => payload(fs.readFileSync(path.join(auto, "stamp.js"), "utf8"), "__boardStamp");
  expect("auto: every write so far kept the page and its data beside the board file", ["index.html", "data.js", "stamp.js"].every((name) => fs.existsSync(path.join(auto, name))));
  expect("auto: the write commands stay quiet about it", !/board written/.test(tool(["note", idNext, "--text", "Catatan untuk memeriksa bahwa halaman ikut berubah sendiri."]).text));
  expect("auto: a change shows in the data without running report", loadData(auto).tickets[idNext].body.includes("halaman ikut berubah sendiri"));
  const before = stamps();
  expect("auto: the stamp file holds the stamps the data was built with", JSON.stringify(before) === JSON.stringify(loadData(auto).stamps));
  tool(["note", idNext, "--text", "Catatan kedua supaya penanda papan berubah lagi."], { now: "2026-11-20T09:00:00+07:00" });
  const after = stamps();
  expect("auto: a change moves the board's stamp and that ticket's, and leaves other tickets' alone", after.board !== before.board && after.tickets[idNext] !== before.tickets[idNext] && after.tickets[id] === before.tickets[id]);
  expect("auto: reading commands do not rewrite anything", (() => { const mark = fs.statSync(path.join(auto, "data.js")).mtimeMs; tool(["list"]); tool(["show", id]); tool(["search", "klaim"]); return fs.statSync(path.join(auto, "data.js")).mtimeMs === mark; })());
  const check = spawnSync(process.execPath, [DOC_TOOLS, "check", path.join(auto, "index.html")], { encoding: "utf8" });
  expect("auto: the page passes doc-tools check with the view and watch scripts in it", check.status === 0, (check.stdout || "") + (check.stderr || ""));
  const plain = tool(["report"]);
  expect("report: without --out it rebuilds the folder beside the board file", plain.code === 0 && plain.text.includes(auto), plain.text);

  // A board whose pages cannot be written still records the ticket.
  const brokenDir = path.join(TMP, "broken");
  fs.mkdirSync(brokenDir);
  fs.writeFileSync(path.join(brokenDir, "site"), "a file where the folder should be");
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, "add", "--file", file(ticket()), "--dir", HRIS], { encoding: "utf8", env: { ...process.env, AETHERIS_BOARD: path.join(brokenDir, "board.db") } });
  const listed = spawnSync(process.execPath, ["--no-warnings", TOOL, "list"], { encoding: "utf8", env: { ...process.env, AETHERIS_BOARD: path.join(brokenDir, "board.db") } });
  expect("auto: when the pages cannot be written the ticket is still saved, with a warning", out.status === 0 && /added kantor-hris-demo-1 /.test(out.stdout) && /pages were not updated/.test(out.stderr) && /^kantor-hris-demo-1\b/m.test(listed.stdout), out.stdout + out.stderr);
}

// --- one number per project, and boards from before -------------------------------------------------
{
  const officeApi = path.join(TMP, "kantor", "api");
  const ownApi = path.join(TMP, "personal", "api");
  fs.mkdirSync(officeApi, { recursive: true });
  fs.mkdirSync(ownApi, { recursive: true });
  const a = keyOf(tool(["add", "--file", file({ ...ticket(), decisions: [] }), "--dir", officeApi]).text);
  const b = keyOf(tool(["add", "--file", file({ ...ticket(), decisions: [] }), "--dir", ownApi]).text);
  expect("keys: two folders with the same name in different groups are two projects, each counting from 1", a === "kantor-api-1" && b === "personal-api-1", `${a} ${b}`);
  const vague = tool(["list", "--project", "api"]);
  expect("list: a folder name two projects share is refused, naming both keys", vague.code === 2 && /kantor-api/.test(vague.text) && /personal-api/.test(vague.text), vague.text);
  expect("list: the full project key picks one", count(tool(["list", "--project", "kantor-api"]).text) === 1);

  // A board written by the earlier version: one number for the whole board, the folder name as the project key.
  const oldDir = path.join(TMP, "old-board");
  fs.mkdirSync(path.join(oldDir, "site"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(path.join(oldDir, "board.db"));
  old.exec(`CREATE TABLE projects (key TEXT PRIMARY KEY, grp TEXT NOT NULL, dir TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL REFERENCES projects(key), title TEXT NOT NULL, status TEXT NOT NULL,
      unanswered INTEGER NOT NULL DEFAULT 0, unseen INTEGER NOT NULL DEFAULT 0, follows INTEGER REFERENCES tickets(id), branch TEXT, type TEXT,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const at = "2026-11-01T09:00:00+07:00";
  const body = (extra) => JSON.stringify({ summary: "Tiket dari papan versi lama yang harus tetap terbaca sesudah pindah ke kunci per proyek.", done_when: ["Tetap terbaca."], sources: [{ claim: "Contoh", source: "uji" }], decisions: [], approved_by: "user", user_words: "gass", type: "feature", history: [{ at, to: "ready" }], ...extra });
  old.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("legacy", "kantor", oldDir, at);
  old.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("other", "personal", oldDir, at);
  const put = old.prepare("INSERT INTO tickets (id, project, title, status, follows, data, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)");
  put.run(5, "legacy", "Tiket lama pertama di proyek legacy", null, body({}), at, at);
  put.run(7, "other", "Tiket lama di proyek lain", null, body({}), at, at);
  put.run(9, "legacy", "Tiket lama yang melanjutkan tiket pertama", 5, body({ follows: 5 }), at, at);
  old.close();
  fs.writeFileSync(path.join(oldDir, "site", "ticket-5.html"), "<p>a page from before</p><!-- board-tools-report -->");
  const env = { ...process.env, AETHERIS_BOARD: path.join(oldDir, "board.db"), BOARD_NOW: "2026-11-21T09:00:00+07:00" };
  const run = (args) => { const o = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], { encoding: "utf8", env }); return { code: o.status, text: (o.stdout || "") + (o.stderr || "") }; };
  const listed = run(["list"]);
  expect("migration: an older board gets keys with the parent folder and numbers per project, in creation order", /^kantor-legacy-1 /m.test(listed.text) && /^kantor-legacy-2 /m.test(listed.text) && /^personal-other-1 /m.test(listed.text) && count(listed.text) === 3, listed.text);
  expect("migration: a follow-up still points at the ticket it continues", /^Follows: kantor-legacy-1$/m.test(run(["show", "kantor-legacy-2"]).text));
  run(["note", "kantor-legacy-1", "--text", "Catatan sesudah papan lama pindah ke kunci per proyek."]);
  expect("migration: the first write builds the one page and clears the old per-ticket pages", fs.existsSync(path.join(oldDir, "site", "data.js")) && !fs.existsSync(path.join(oldDir, "site", "ticket-5.html")));
  expect("migration: running again changes nothing", run(["list"]).text === listed.text);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
