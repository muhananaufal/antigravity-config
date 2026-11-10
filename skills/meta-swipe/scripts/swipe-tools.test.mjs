#!/usr/bin/env node
// Tests for swipe-tools. A valid checklist and run must pass; every mutation below must be rejected
// with the expected message. A mutation that changes nothing is reported as NOT APPLIED.
//
//   node swipe-tools.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "swipe-tools.mjs");
const DOC_TOOLS = path.join(HERE, "..", "..", "meta-prd", "scripts", "doc-tools.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "swipe-tools-test-"));

const checklist = () => ({
  version: 1,
  project: "hris",
  roles: [
    { id: "hrd", label: "HRD", baseUrl: "http://hrd.localhost" },
    { id: "karyawan", label: "Karyawan", baseUrl: "http://karyawan.localhost:8000" },
  ],
  features: [
    { id: "reimbursement", label: "Reimbursement", related: ["field-duty"], foundIn: ["routes/web.php"] },
    { id: "field-duty", label: "Field Duty", related: [], foundIn: ["routes/web.php"] },
    { id: "booking", label: "Booking ruangan", related: [], foundIn: ["routes/web.php"] },
  ],
  checks: [
    { id: "reimbursement-karyawan-submit", feature: "reimbursement", role: "karyawan", title: "Mengajukan klaim", steps: ["Buka /reimburse/create", "Isi rute", "Simpan"], expect: "Klaim baru berstatus pending", kind: "write" },
    { id: "reimbursement-hrd-list", feature: "reimbursement", role: "hrd", title: "Daftar klaim terbuka", steps: ["Buka /reimburse"], expect: "Tabel tampil dengan klaim semua karyawan", kind: "read" },
    { id: "reimbursement-hrd-delete", feature: "reimbursement", role: "hrd", title: "Menghapus klaim", steps: ["Klik Delete pada satu klaim"], expect: "Klaim hilang dari daftar", kind: "irreversible" },
    { id: "field-duty-karyawan-list", feature: "field-duty", role: "karyawan", title: "Daftar Field Duty", steps: ["Buka /off?type=field"], expect: "Daftar tampil", kind: "read" },
    { id: "booking-karyawan-list", feature: "booking", role: "karyawan", title: "Daftar booking", steps: ["Buka /booking"], expect: "Daftar tampil", kind: "read" },
  ],
});

const oldRun = () => ({
  version: 1, project: "hris", date: "2026-11-01", scope: "reimbursement",
  basis: "staging 1111111", browser: "Chrome",
  results: [
    { check: "reimbursement-karyawan-submit", status: "pass", observed: "Klaim #11 dibuat, status pending" },
    { check: "reimbursement-hrd-list", status: "fail", observed: "Tabel kosong", console: ["TypeError: x is undefined"] },
    { check: "field-duty-karyawan-list", status: "pass", observed: "Daftar tampil" },
  ],
  created: [{ role: "karyawan", what: "Klaim #11", where: "/reimburse/11" }],
});

const newRun = () => ({
  version: 1, project: "hris", date: "2026-11-10", scope: "reimbursement",
  basis: "staging 797a07f (+2 berkas belum commit)", browser: "Chrome lewat Claude in Chrome",
  results: [
    { check: "reimbursement-karyawan-submit", status: "fail", observed: "Simpan menjawab 500 <script>alert(1)</script>", network: [{ method: "POST", url: "/reimburse/store", status: 500 }] },
    // Went from fail to pass and carries an expected 422: that is a fix, not a "new error".
    { check: "reimbursement-hrd-list", status: "pass", observed: "Tabel tampil, 12 baris", network: [{ method: "POST", url: "/reimburse/filter", status: 422 }] },
    { check: "reimbursement-hrd-delete", status: "skipped", reason: "Tidak bisa dibatalkan; user memilih tidak dijalankan" },
    { check: "field-duty-karyawan-list", status: "pass", observed: "Daftar tampil", console: ["Warning: deprecated API"] },
  ],
  created: [],
  notes: ["Tampilan HP tidak dicoba."],
});

function write(name, data) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function tool(...args) {
  const out = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { code: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

let failures = 0;
function expect(name, condition, detail) {
  if (condition) console.log(`ok    ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${detail.trim().split("\n").slice(0, 6).join("\n      ")}` : ""}`); }
}

// --- baseline -----------------------------------------------------------------------------------
const goodChecklist = write("checklist.json", checklist());
const goodOld = write("old.json", oldRun());
const goodNew = write("new.json", newRun());
{
  const r = tool("validate", goodChecklist, goodOld, goodNew);
  expect("valid checklist and runs pass", r.code === 0 && /3 file\(s\) checked, 0 failed/.test(r.text), r.text);
}

// --- negative controls: checklist ---------------------------------------------------------------
const CHECKLIST_MUTATIONS = [
  ["password key", (c) => { c.roles[0].password = "rahasia"; }, /must not store credentials.*password/],
  ["token key nested", (c) => { c.roles[0].auth = { apiToken: "abc" }; }, /must not store credentials.*apiToken/],
  ["credentials in url", (c) => { c.roles[0].baseUrl = "http://admin:rahasia@hrd.localhost"; }, /credentials inside a URL/],
  ["non-local host", (c) => { c.roles[0].baseUrl = "https://hris.example.com"; }, /not a local address/],
  ["duplicate check id", (c) => { c.checks[1].id = c.checks[0].id; }, /duplicate check id/],
  ["unknown role", (c) => { c.checks[0].role = "founder"; }, /unknown role "founder"/],
  ["unknown feature", (c) => { c.checks[0].feature = "payroll"; }, /unknown feature "payroll"/],
  ["unknown related feature", (c) => { c.features[0].related = ["payroll"]; }, /related feature "payroll" does not exist/],
  ["bad kind", (c) => { c.checks[0].kind = "danger"; }, /kind must be one of/],
  ["empty steps", (c) => { c.checks[0].steps = []; }, /needs at least one step/],
  ["missing expect", (c) => { delete c.checks[0].expect; }, /missing "expect"/],
  ["id not kebab-case", (c) => { c.checks[0].id = "Reimbursement Submit"; }, /not lowercase kebab-case/],
  ["wrong version", (c) => { c.version = 2; }, /version must be 1/],
];
for (const [name, mutate, pattern] of CHECKLIST_MUTATIONS) {
  const data = checklist();
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) { failures++; console.log(`NOT APPLIED  ${name}`); continue; }
  const r = tool("validate", write("bad-checklist.json", data));
  expect(`checklist: ${name}`, r.code === 1 && pattern.test(r.text), r.text);
}
{
  const data = checklist();
  data.roles[0].baseUrl = "https://dev.hris.example.com";
  data.roles[0].nonLocalConfirmed = true;
  const r = tool("validate", write("confirmed-checklist.json", data));
  expect("checklist: non-local host passes once confirmed", r.code === 0, r.text);
}

// --- negative controls: run ---------------------------------------------------------------------
const RUN_MUTATIONS = [
  ["unknown check", (r) => { r.results[0].check = "tidak-ada"; }, /unknown check "tidak-ada"/],
  ["duplicate result", (r) => { r.results[1].check = r.results[0].check; }, /more than one result/],
  ["bad status", (r) => { r.results[0].status = "ok"; }, /status must be one of/],
  ["fail without observed", (r) => { delete r.results[0].observed; }, /needs "observed"/],
  ["skipped without reason", (r) => { delete r.results[2].reason; }, /needs "reason"/],
  ["irreversible executed without confirmation", (r) => { r.results[2] = { check: "reimbursement-hrd-delete", status: "pass", observed: "Klaim terhapus" }; }, /irreversible.*"confirmed": true/],
  ["token in network url", (r) => { r.results[0].network[0].url = "/reimburse/store?token=abc123"; }, /credential in a query string/],
  ["cookie key", (r) => { r.cookie = "laravel_session=abc"; }, /must not store credentials.*cookie/],
  ["bad date", (r) => { r.date = "10-11-2026"; }, /date must be YYYY-MM-DD/],
  ["project mismatch", (r) => { r.project = "other"; }, /project "other" does not match/],
];
for (const [name, mutate, pattern] of RUN_MUTATIONS) {
  const data = newRun();
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) { failures++; console.log(`NOT APPLIED  ${name}`); continue; }
  const r = tool("validate", goodChecklist, write("bad-run.json", data));
  expect(`run: ${name}`, r.code === 1 && pattern.test(r.text), r.text);
}
{
  const data = newRun();
  data.results[2] = { check: "reimbursement-hrd-delete", status: "pass", observed: "Klaim terhapus", confirmed: true };
  const r = tool("validate", goodChecklist, write("confirmed-run.json", data));
  expect("run: irreversible passes once confirmed", r.code === 0, r.text);
}

// --- plan ---------------------------------------------------------------------------------------
{
  const r = tool("plan", goodChecklist, "--feature", "reimbursement");
  expect("plan: includes the feature and its related feature, not others",
    r.code === 0 && /reimbursement-hrd-list/.test(r.text) && /field-duty-karyawan-list/.test(r.text) && !/booking-karyawan-list/.test(r.text) && /4 check\(s\)/.test(r.text), r.text);
  const one = tool("plan", goodChecklist, "--feature", "reimbursement", "--role", "hrd");
  expect("plan: role filter", one.code === 0 && /2 check\(s\)/.test(one.text) && !/karyawan-submit/.test(one.text), one.text);
  const none = tool("plan", goodChecklist, "--feature", "payroll");
  expect("plan: unknown feature is an error", none.code === 2 && /unknown feature "payroll"/.test(none.text), none.text);
  const flagged = tool("plan", goodChecklist);
  expect("plan: irreversible checks are flagged", /ASK FIRST.*reimbursement-hrd-delete|reimbursement-hrd-delete.*ASK FIRST/.test(flagged.text) && /5 check\(s\)/.test(flagged.text), flagged.text);
}

// --- diff ---------------------------------------------------------------------------------------
{
  const r = tool("diff", goodChecklist, goodOld, goodNew, "--json");
  let d = null;
  try { d = JSON.parse(r.text); } catch { /* reported below */ }
  expect("diff: json output parses", r.code === 0 && d !== null, r.text);
  if (d) {
    expect("diff: regression detected", d.regressed.length === 1 && d.regressed[0].check === "reimbursement-karyawan-submit", JSON.stringify(d.regressed));
    expect("diff: fix detected", d.fixed.length === 1 && d.fixed[0].check === "reimbursement-hrd-list", JSON.stringify(d.fixed));
    expect("diff: new check detected", d.added.length === 1 && d.added[0].check === "reimbursement-hrd-delete", JSON.stringify(d.added));
    expect("diff: new errors on a passing check detected", d.newErrors.length === 1 && d.newErrors[0].check === "field-duty-karyawan-list", JSON.stringify(d.newErrors));
    expect("diff: nothing dropped, nothing still failing", d.notRerun.length === 0 && d.stillFailing.length === 0, JSON.stringify(d));
  }
  const same = tool("diff", goodChecklist, goodNew, goodNew, "--json");
  let s = null;
  try { s = JSON.parse(same.text); } catch { /* reported below */ }
  expect("diff: identical runs report no change", s !== null && s.regressed.length + s.fixed.length + s.added.length + s.newErrors.length + s.notRerun.length === 0 && s.stillFailing.length === 1, same.text);
}

// --- report -------------------------------------------------------------------------------------
{
  const out = path.join(TMP, "hris-swipe-2026-11-10-reimbursement.html");
  const r = tool("report", goodChecklist, goodNew, "--prev", goodOld, "--out", out);
  expect("report: written", r.code === 0 && fs.existsSync(out), r.text);
  if (fs.existsSync(out)) {
    const html = fs.readFileSync(out, "utf8");
    const check = spawnSync(process.execPath, [DOC_TOOLS, "check", out], { encoding: "utf8" });
    expect("report: passes doc-tools check", check.status === 0, (check.stdout || "") + (check.stderr || ""));
    expect("report: observed text is escaped", !html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    expect("report: shows the regression and the skipped reason", /Memburuk/.test(html) && html.includes("user memilih tidak dijalankan"));
    expect("report: lists checks that were not run", html.includes("booking-karyawan-list"));
    expect("report: no table gives check ids a column of their own", !/<th>ID<\/th><th>Pemeriksaan<\/th>/.test(html) && !/<th>Pemeriksaan<\/th><th>Peran<\/th>/.test(html));
    expect("report: the comparison names the earlier run by scope and date", html.includes("swipe reimbursement, 1 November 2026"));
    const again = tool("report", goodChecklist, goodNew, "--out", out);
    expect("report: refuses to overwrite", again.code === 2 && /refusing to overwrite/.test(again.text), again.text);
    const replaced = tool("report", goodChecklist, goodNew, "--out", out, "--replace");
    expect("report: --replace regenerates", replaced.code === 0, replaced.text);
  }
  const bad = newRun();
  bad.results[0].status = "ok";
  const refuse = tool("report", goodChecklist, write("bad-run.json", bad), "--out", path.join(TMP, "hris-swipe-2026-11-10-bad.html"));
  expect("report: refuses an invalid run", refuse.code === 1 && !fs.existsSync(path.join(TMP, "hris-swipe-2026-11-10-bad.html")), refuse.text);
}

// --- init ---------------------------------------------------------------------------------------
{
  const dir = path.join(TMP, "project");
  fs.mkdirSync(dir);
  const r = tool("init", dir, "--project", "hris");
  const file = path.join(dir, ".swipe", "checklist.json");
  expect("init: creates .swipe/checklist.json and runs/", r.code === 0 && fs.existsSync(file) && fs.existsSync(path.join(dir, ".swipe", "runs")), r.text);
  const again = tool("init", dir, "--project", "hris");
  expect("init: refuses to overwrite", again.code === 2 && /refusing to overwrite/.test(again.text), again.text);
  const empty = tool("validate", file);
  expect("init: the empty skeleton is reported as empty, not as valid", empty.code === 1 && /no roles/.test(empty.text), empty.text);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
