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
const count = (text) => (text.match(/^#\d+/gm) || []).length;

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
  sources: [{ claim: "Klaim disimpan per foto struk, bukan per duty", source: "app/Services/ReimburseService.php:88", status: "dibaca utuh" }],
  approved_by: "user",
  user_words: "gass",
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
  id = (/#(\d+)/.exec(a.text) || [])[1];
  expect("add: ticket with summary, decision and source", a.code === 0 && id, a.text);
  const b = tool(["add", "--file", file({ ...ticket(), title: "Tema blog memakai huruf serif", decisions: [], user_words: "serif aja" }), "--dir", BLOG]);
  idBlog = (/#(\d+)/.exec(b.text) || [])[1];
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
  const none = tool(["decide", "999", "--file", file(agentDecision())]);
  expect("decide: a decision cannot exist without its ticket", none.code === 2 && /no ticket #999/.test(none.text), none.text);
  const s = tool(["source", id, "--file", file({ claim: "Batas lima foto struk ditulis sebagai konstanta", source: "app/Services/ReimburseService.php:14", status: "dibaca utuh" })]);
  expect("source: appends a source", s.code === 0 && /E2/.test(s.text), s.text);

  const shown = tool(["show", id]);
  expect("show: summary, decisions and sources are all inside the ticket",
    shown.code === 0 && /Ringkasan:/.test(shown.text) && /Keputusan:/.test(shown.text) && /Daftar sumber:/.test(shown.text)
    && /K1/.test(shown.text) && /K2/.test(shown.text) && /K3/.test(shown.text) && /E2/.test(shown.text), shown.text);
  expect("show: full text comes back unchanged", shown.text.includes(LONG) && shown.text.includes("per duty aja ya, biar yang dinas panjang ngga kepotong <b>ya</b>") && /Dihitung per klaim/.test(shown.text), shown.text);
}

// --- reading stays small -------------------------------------------------------------------------
{
  const all = tool(["list"]);
  const rows = all.text.split("\n").filter((line) => /^#\d+/.test(line));
  expect("list: one short line per ticket", all.code === 0 && rows.length === 2 && rows.every((line) => line.length < 200), all.text);
  expect("list: never prints the long text", !all.text.includes("sengaja panjang"), all.text);
  const one = tool(["list", "--project", "hris-demo"]);
  expect("list: project filter isolates", count(one.text) === 1 && !/Tema blog/.test(one.text), one.text);
  const group = tool(["list", "--group", "personal"]);
  expect("list: group filter", count(group.text) === 1 && /Tema blog/.test(group.text), group.text);
  const limited = tool(["list", "--limit", "1"]);
  expect("list: limit is applied and the remainder is announced", count(limited.text) === 1 && /1 more/.test(limited.text), limited.text);
  const found = tool(["search", "konstanta"]);
  expect("search: a word from a decision leads to its ticket", found.code === 0 && new RegExp(`^#${id}\\b`, "m").test(found.text) && !found.text.includes("sengaja panjang"), found.text);
  const scoped = tool(["search", "serif", "--project", "hris-demo"]);
  expect("search: respects the project filter", scoped.code === 0 && count(scoped.text) === 0, scoped.text);
}

// --- waiting for the owner -----------------------------------------------------------------------
{
  const waiting = tool(["list", "--waiting"]);
  expect("waiting: lists the ticket with an unanswered question and an unseen agent decision", count(waiting.text) === 1 && new RegExp(`^#${id}\\b`, "m").test(waiting.text), waiting.text);
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

// --- status needs evidence -----------------------------------------------------------------------
{
  const bare = tool(["set", id, "--status", "selesai"]);
  expect("set: done without evidence is refused", bare.code === 1 && /evidence/.test(bare.text), bare.text);
  const doing = tool(["set", id, "--status", "dikerjakan"]);
  expect("set: in progress needs no evidence", doing.code === 0, doing.text);
  const done = tool(["set", id, "--status", "selesai", "--evidence", "php artisan test: 412 lulus, 0 gagal; commit a1b2c3d"], { now: "2026-11-12T15:00:00+07:00" });
  const shown = tool(["show", id]);
  expect("set: done with evidence is stored with its date", done.code === 0 && /412 lulus/.test(shown.text) && /2026-11-12/.test(shown.text), shown.text);
  const bad = tool(["set", id, "--status", "beres"]);
  expect("set: unknown status is refused", bad.code === 1 && /status must be one of/.test(bad.text), bad.text);
}

// --- export and pages ----------------------------------------------------------------------------
{
  const exported = tool(["export", "--project", "hris-demo"]);
  let parsed = null;
  try { parsed = JSON.parse(exported.text); } catch { /* reported below */ }
  expect("export: valid JSON for one project, decisions nested in the ticket", parsed !== null && parsed.tickets.length === 1 && parsed.tickets[0].decisions.length === 3, exported.text.slice(0, 300));

  const site = path.join(TMP, "site");
  const r = tool(["report", "--out", site]);
  const index = path.join(site, "index.html");
  const page = path.join(site, `tiket-${id}.html`);
  expect("report: board page and one page per ticket", r.code === 0 && fs.existsSync(index) && fs.existsSync(page) && fs.existsSync(path.join(site, `tiket-${idBlog}.html`)), r.text);
  if (fs.existsSync(index) && fs.existsSync(page)) {
    const board = fs.readFileSync(index, "utf8");
    const detail = fs.readFileSync(page, "utf8");
    for (const [label, target] of [["board", index], ["ticket", page]]) {
      const check = spawnSync(process.execPath, [DOC_TOOLS, "check", target], { encoding: "utf8" });
      expect(`report: ${label} page passes doc-tools check`, check.status === 0, (check.stdout || "") + (check.stderr || ""));
    }
    expect("report: board cards link to their ticket page and carry the project for filtering", board.includes(`href="tiket-${id}.html"`) && board.includes('data-project="hris-demo"') && board.includes('data-project="blog-pribadi"'));
    expect("report: the board does not carry ticket details", !board.includes("sengaja panjang"));
    expect("report: ticket page has summary, decisions and sources", /id="ringkasan"/.test(detail) && /id="keputusan"/.test(detail) && /id="sumber"/.test(detail) && detail.includes("sengaja panjang dan lengkap") && detail.includes("ReimburseService.php:14"));
    expect("report: ticket page links back to the board", detail.includes('href="index.html"'));
    expect("report: owner's words are escaped, not interpreted", detail.includes("&lt;b&gt;ya&lt;/b&gt;") && !detail.includes("<b>ya</b>"));
    expect("report: shows who decided", /Diputuskan kamu/.test(detail) && /Diputuskan agen/.test(detail));
    expect("report: no table of contents sidebar", /nav\.toc[^}]*display:\s*none/.test(board) && /nav\.toc[^}]*display:\s*none/.test(detail));
    const again = tool(["report", "--out", site]);
    expect("report: regenerating replaces its own output", again.code === 0, again.text);
    fs.writeFileSync(path.join(site, "tiket-1.html"), "<p>not ours</p>");
    const foreign = tool(["report", "--out", site]);
    expect("report: refuses to overwrite a file it did not write", foreign.code === 2 && /did not write/.test(foreign.text), foreign.text);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
