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
const HRIS = path.join(TMP, "devivace", "altrms-demo");
const BLOG = path.join(TMP, "personal", "Blog Pribadi");
fs.mkdirSync(HRIS, { recursive: true });
fs.mkdirSync(BLOG, { recursive: true });

function tool(args, { cwd = TMP, now = "2026-11-10T09:00:00+07:00" } = {}) {
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, AETHERIS_BOARD: DB, BOARD_NOW: now },
  });
  return { code: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

let counter = 0;
function entry(data) {
  const file = path.join(TMP, `entry-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

let failures = 0;
function expect(name, condition, detail) {
  if (condition) console.log(`ok    ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).trim().split("\n").slice(0, 8).join("\n      ")}` : ""}`); }
}

const LONG = "Batas klaim dihitung per duty, bukan per klaim, supaya Field Duty lima hari tetap bisa diklaim penuh. Kalimat ini sengaja panjang dan lengkap, dan harus tersimpan apa adanya tanpa dipendekkan.";

const userDecision = () => ({
  kind: "decision",
  title: "Batas klaim reimburse dihitung per duty",
  question: "Batas tiga per bulan itu menghitung klaim atau duty?",
  chosen: "Dihitung per duty.",
  reason: LONG,
  rejected: [{ option: "Dihitung per klaim", reason: "Field Duty lebih dari tiga hari tidak bisa diklaim penuh." }],
  decided_by: "user",
  user_words: "per duty aja ya, biar yang dinas panjang ngga kepotong",
});

const agentDecision = () => ({
  kind: "decision",
  title: "Angka batas ditulis sebagai konstanta di service",
  question: "Angka tiga disimpan di mana?",
  chosen: "Sebagai konstanta di ReimburseService, seperti batas lima foto struk.",
  reason: "Pemilik tidak meminta angka yang bisa diatur, dan modul ini sudah memakai pola konstanta.",
  rejected: [{ option: "Kolom pengaturan per perusahaan", reason: "Butuh migrasi dan layar baru yang tidak diminta." }],
  decided_by: "agent",
  authority: "pakai bawaanmu saja untuk yang kecil-kecil",
});

const task = () => ({
  kind: "task",
  title: "Batas tiga duty yang diklaim per karyawan per bulan",
  body: "Permintaan pemilik: tambahkan batas reimburse transport. Disetujui dengan batas dihitung per duty.",
  done_when: ["Karyawan dengan tiga duty yang sudah diklaim melihat pesan batas saat mengajukan duty keempat.", "Klaim kedua pada duty yang sama tetap tersimpan."],
  decided_by: "user",
  user_words: "gass",
});

// --- projects are created on first use -----------------------------------------------------------
{
  const first = tool(["project", "ensure", "--dir", HRIS]);
  expect("project: created from the folder name and its parent", first.code === 0 && /altrms-demo/.test(first.text) && /devivace/.test(first.text) && /created/.test(first.text), first.text);
  const again = tool(["project", "ensure", "--dir", HRIS]);
  expect("project: second call does not create a duplicate", again.code === 0 && /exists/.test(again.text), again.text);
  const listed = tool(["project", "list"]);
  expect("project: listed once", (listed.text.match(/altrms-demo/g) || []).length === 1, listed.text);
}

// --- adding entries ------------------------------------------------------------------------------
let idUser = null, idAgent = null, idTask = null;
{
  const a = tool(["add", "--file", entry(userDecision()), "--dir", HRIS]);
  idUser = (/#(\d+)/.exec(a.text) || [])[1];
  expect("add: decision by the owner", a.code === 0 && idUser, a.text);
  const b = tool(["add", "--file", entry(agentDecision()), "--dir", HRIS]);
  idAgent = (/#(\d+)/.exec(b.text) || [])[1];
  expect("add: decision by the agent", b.code === 0 && idAgent, b.text);
  const c = tool(["add", "--file", entry(task()), "--dir", HRIS]);
  idTask = (/#(\d+)/.exec(c.text) || [])[1];
  expect("add: task from an approved panel", c.code === 0 && idTask, c.text);
  const d = tool(["add", "--file", entry({ ...userDecision(), title: "Tema blog memakai huruf serif", user_words: "serif aja biar enak dibaca <b>lama</b>" }), "--dir", BLOG]);
  expect("add: unknown project is created on the way, key made kebab-case", d.code === 0 && /blog-pribadi/.test(d.text) && /personal/.test(d.text), d.text);
}

const REJECTED = [
  ["owner decision without the owner's words", (e) => { delete e.user_words; }, userDecision, /user_words/],
  ["agent decision without the sentence that allowed it", (e) => { delete e.authority; }, agentDecision, /authority/],
  ["decision without rejected options", (e) => { e.rejected = []; }, userDecision, /rejected/],
  ["decision without a reason", (e) => { e.reason = " "; }, userDecision, /reason/],
  ["task without done_when", (e) => { e.done_when = []; }, task, /done_when/],
  ["unknown kind", (e) => { e.kind = "note"; }, userDecision, /kind must be one of/],
  ["unknown decided_by", (e) => { e.decided_by = "ai"; }, userDecision, /decided_by must be/],
  ["password key", (e) => { e.password = "rahasia"; }, userDecision, /must not store credentials/],
  ["token in text", (e) => { e.reason = "panggil https://x.test/api?token=abc123 dulu"; }, userDecision, /credential in a query string/],
  ["title too short to be read by a person", (e) => { e.title = "klaim"; }, userDecision, /title/],
];
for (const [name, mutate, make, pattern] of REJECTED) {
  const data = make();
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) { failures++; console.log(`NOT APPLIED  ${name}`); continue; }
  const r = tool(["add", "--file", entry(data), "--dir", HRIS]);
  expect(`add rejects: ${name}`, r.code === 1 && pattern.test(r.text), r.text);
}

// --- reading stays small -------------------------------------------------------------------------
{
  const all = tool(["list"]);
  const rows = all.text.split("\n").filter((line) => /^#\d+/.test(line));
  expect("list: one short line per entry", all.code === 0 && rows.length === 4 && rows.every((line) => line.length < 200), all.text);
  expect("list: never prints the long text", !all.text.includes("sengaja panjang"), all.text);
  const one = tool(["list", "--project", "altrms-demo"]);
  expect("list: project filter isolates", one.code === 0 && !/Tema blog/.test(one.text) && (one.text.match(/^#\d+/gm) || []).length === 3, one.text);
  const group = tool(["list", "--group", "personal"]);
  expect("list: group filter", (group.text.match(/^#\d+/gm) || []).length === 1 && /Tema blog/.test(group.text), group.text);
  const limited = tool(["list", "--limit", "2"]);
  expect("list: limit is applied and the remainder is announced", (limited.text.match(/^#\d+/gm) || []).length === 2 && /2 more/.test(limited.text), limited.text);
  const shown = tool(["show", idUser]);
  expect("show: full text comes back unchanged", shown.code === 0 && shown.text.includes(LONG) && shown.text.includes("per duty aja ya, biar yang dinas panjang ngga kepotong") && /Dihitung per klaim/.test(shown.text), shown.text);
  const found = tool(["search", "Field Duty"]);
  expect("search: finds a word from the long text", found.code === 0 && new RegExp(`#${idUser}\\b`).test(found.text) && !found.text.includes("sengaja panjang"), found.text);
  const scoped = tool(["search", "serif", "--project", "altrms-demo"]);
  expect("search: respects the project filter", scoped.code === 0 && !/Tema blog/.test(scoped.text), scoped.text);
}

// --- who decided, and review ---------------------------------------------------------------------
{
  const pending = tool(["list", "--unreviewed"]);
  expect("unreviewed: lists only what the agent decided", (pending.text.match(/^#\d+/gm) || []).length === 1 && new RegExp(`#${idAgent}\\b`).test(pending.text), pending.text);
  const reviewed = tool(["review", idAgent]);
  expect("review: marks an agent decision as seen", reviewed.code === 0, reviewed.text);
  const after = tool(["list", "--unreviewed"]);
  expect("unreviewed: empty afterwards", (after.text.match(/^#\d+/gm) || []).length === 0, after.text);
  const wrong = tool(["review", idUser]);
  expect("review: only applies to agent decisions", wrong.code === 1 && /decided by the owner/.test(wrong.text), wrong.text);
}

// --- status needs evidence -----------------------------------------------------------------------
{
  const bare = tool(["set", idTask, "--status", "selesai"]);
  expect("set: done without evidence is refused", bare.code === 1 && /evidence/.test(bare.text), bare.text);
  const doing = tool(["set", idTask, "--status", "dikerjakan"]);
  expect("set: in progress needs no evidence", doing.code === 0, doing.text);
  const done = tool(["set", idTask, "--status", "selesai", "--evidence", "php artisan test: 412 lulus, 0 gagal; commit a1b2c3d"], { now: "2026-11-12T15:00:00+07:00" });
  const shown = tool(["show", idTask]);
  expect("set: done with evidence is stored with its date", done.code === 0 && /412 lulus/.test(shown.text) && /2026-11-12/.test(shown.text), shown.text);
  const bad = tool(["set", idTask, "--status", "beres"]);
  expect("set: unknown status is refused", bad.code === 1 && /status must be one of/.test(bad.text), bad.text);
}

// --- export and report ---------------------------------------------------------------------------
{
  const exported = tool(["export", "--project", "altrms-demo"]);
  let parsed = null;
  try { parsed = JSON.parse(exported.text); } catch { /* reported below */ }
  expect("export: valid JSON for one project", parsed !== null && parsed.entries.length === 3 && parsed.entries.every((e) => e.project === "altrms-demo"), exported.text.slice(0, 300));

  const out = path.join(TMP, "papan-kerja.html");
  const r = tool(["report", "--out", out]);
  expect("report: written", r.code === 0 && fs.existsSync(out), r.text);
  if (fs.existsSync(out)) {
    const html = fs.readFileSync(out, "utf8");
    const check = spawnSync(process.execPath, [DOC_TOOLS, "check", out], { encoding: "utf8" });
    expect("report: passes doc-tools check", check.status === 0, (check.stdout || "") + (check.stderr || ""));
    expect("report: both projects present and tagged for filtering", html.includes('data-project="altrms-demo"') && html.includes('data-project="blog-pribadi"'));
    expect("report: owner's words are escaped, not interpreted", html.includes("&lt;b&gt;lama&lt;/b&gt;") && !html.includes("<b>lama</b>"));
    expect("report: shows who decided", /Diputuskan kamu/.test(html) && /Diputuskan agen/.test(html));
    expect("report: full sentences are kept", html.includes("sengaja panjang dan lengkap"));
    const again = tool(["report", "--out", out]);
    expect("report: regenerating replaces its own output", again.code === 0, again.text);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
