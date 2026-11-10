#!/usr/bin/env node
// swipe-tools: keeps the swipe checklist, the run records, and the HTML report consistent.
//
//   node swipe-tools.mjs init <project-dir> --project <slug>      create .swipe/checklist.json and .swipe/runs/
//   node swipe-tools.mjs validate <checklist.json> [run.json...]  verify the checklist and any runs against it
//   node swipe-tools.mjs plan <checklist.json> [--feature a,b] [--role x,y]
//                                                                 list the checks to run, related features included
//   node swipe-tools.mjs diff <checklist.json> <old-run.json> <new-run.json> [--json]
//                                                                 what changed between two runs
//   node swipe-tools.mjs report <checklist.json> <run.json> --out <file.html> [--prev <old-run.json>] [--replace]
//                                                                 build the HTML report on the shared doc-style
//
// Exit codes: 0 ok, 1 the data has problems, 2 usage or environment error.
// No dependencies; Node 18+. The report skeleton comes from meta-prd's doc-tools, never from this file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_TOOLS = path.join(HERE, "..", "..", "meta-prd", "scripts", "doc-tools.mjs");

const KINDS = ["read", "write", "irreversible"];
const STATUSES = ["pass", "fail", "blocked", "skipped"];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CREDENTIAL_KEY = /pass(word|wd)?$|secret|token|api[-_]?key|cookie|authorization|credential/i;
const CREDENTIAL_QUERY = /[?&](token|access_token|password|passwd|secret|api_?key|key|signature)=[^&\s]+/i;
const URL_WITH_LOGIN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

class UsageError extends Error {}

function readJson(file) {
  if (!fs.existsSync(file)) throw new UsageError(`file not found: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${error.message}`);
  }
}

function isLocalHost(host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1" || name.endsWith(".localhost") || name.endsWith(".test") || name.endsWith(".local")) return true;
  const parts = name.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

// Walks any JSON value and reports credential-looking keys and values. Records never hold secrets.
function findCredentials(value, trail, problems) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findCredentials(item, `${trail}[${index}]`, problems));
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) problems.push(`${trail}: must not store credentials (key "${key}")`);
      else findCredentials(inner, trail ? `${trail}.${key}` : key, problems);
    }
  } else if (typeof value === "string") {
    if (URL_WITH_LOGIN.test(value)) problems.push(`${trail}: credentials inside a URL`);
    if (CREDENTIAL_QUERY.test(value)) problems.push(`${trail}: credential in a query string`);
  }
}

const isText = (value) => typeof value === "string" && value.trim().length > 0;

function validateChecklist(list) {
  const problems = [];
  if (list === null || typeof list !== "object" || Array.isArray(list)) return ["checklist must be a JSON object"];
  findCredentials(list, "", problems);
  if (list.version !== 1) problems.push("version must be 1");
  if (!isText(list.project) || !KEBAB.test(list.project)) problems.push('"project" must be a lowercase kebab-case name');

  const roles = Array.isArray(list.roles) ? list.roles : [];
  const features = Array.isArray(list.features) ? list.features : [];
  const checks = Array.isArray(list.checks) ? list.checks : [];
  if (!roles.length) problems.push("no roles: add every role that will be swiped, with its base URL");
  if (!features.length) problems.push("no features");
  if (!checks.length) problems.push("no checks");

  const roleIds = new Set();
  for (const role of roles) {
    const where = `role "${role?.id}"`;
    if (!isText(role?.id) || !KEBAB.test(role.id)) problems.push(`${where}: id is not lowercase kebab-case`);
    if (roleIds.has(role?.id)) problems.push(`duplicate role id "${role?.id}"`);
    roleIds.add(role?.id);
    if (!isText(role?.label)) problems.push(`${where}: missing "label"`);
    let url = null;
    try { url = new URL(role?.baseUrl); } catch { problems.push(`${where}: baseUrl is not a URL`); }
    if (url) {
      if (url.username || url.password) problems.push(`${where}: credentials inside a URL`);
      if (!/^https?:$/.test(url.protocol)) problems.push(`${where}: baseUrl must be http or https`);
      if (!isLocalHost(url.hostname) && role.nonLocalConfirmed !== true) {
        problems.push(`${where}: ${url.hostname} is not a local address; swipe runs only where the owner named it, so set "nonLocalConfirmed": true after the owner confirms this exact address`);
      }
    }
  }

  const featureIds = new Set();
  for (const feature of features) {
    const where = `feature "${feature?.id}"`;
    if (!isText(feature?.id) || !KEBAB.test(feature.id)) problems.push(`${where}: id is not lowercase kebab-case`);
    if (featureIds.has(feature?.id)) problems.push(`duplicate feature id "${feature?.id}"`);
    featureIds.add(feature?.id);
    if (!isText(feature?.label)) problems.push(`${where}: missing "label"`);
  }
  for (const feature of features) {
    for (const other of Array.isArray(feature?.related) ? feature.related : []) {
      if (!featureIds.has(other)) problems.push(`feature "${feature.id}": related feature "${other}" does not exist`);
    }
  }

  const checkIds = new Set();
  for (const check of checks) {
    const where = `check "${check?.id}"`;
    if (!isText(check?.id) || !KEBAB.test(check.id)) problems.push(`${where}: id is not lowercase kebab-case`);
    if (checkIds.has(check?.id)) problems.push(`duplicate check id "${check?.id}"`);
    checkIds.add(check?.id);
    if (!roleIds.has(check?.role)) problems.push(`${where}: unknown role "${check?.role}"`);
    if (!featureIds.has(check?.feature)) problems.push(`${where}: unknown feature "${check?.feature}"`);
    if (!isText(check?.title)) problems.push(`${where}: missing "title"`);
    if (!isText(check?.expect)) problems.push(`${where}: missing "expect"`);
    if (!KINDS.includes(check?.kind)) problems.push(`${where}: kind must be one of ${KINDS.join(", ")}`);
    if (!Array.isArray(check?.steps) || !check.steps.length || !check.steps.every(isText)) problems.push(`${where}: needs at least one step, each a non-empty string`);
  }
  return problems;
}

function validateRun(run, list) {
  const problems = [];
  if (run === null || typeof run !== "object" || Array.isArray(run)) return ["run must be a JSON object"];
  findCredentials(run, "", problems);
  if (run.version !== 1) problems.push("version must be 1");
  if (run.project !== list.project) problems.push(`project "${run.project}" does not match the checklist project "${list.project}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(run.date || "") || Number.isNaN(Date.parse(run.date))) problems.push("date must be YYYY-MM-DD");
  if (!isText(run.scope) || !KEBAB.test(run.scope)) problems.push('"scope" must be a lowercase kebab-case name (it goes into the report file name)');
  if (!isText(run.basis)) problems.push('missing "basis": the branch and commit that were running, or what the app was built from');
  if (!isText(run.browser)) problems.push('missing "browser"');

  const checks = new Map((list.checks || []).map((check) => [check.id, check]));
  const results = Array.isArray(run.results) ? run.results : [];
  if (!results.length) problems.push("no results");
  const seen = new Set();
  for (const result of results) {
    const where = `result "${result?.check}"`;
    const check = checks.get(result?.check);
    if (!check) { problems.push(`${where}: unknown check "${result?.check}" (add it to the checklist first)`); continue; }
    if (seen.has(result.check)) problems.push(`${where}: more than one result for the same check`);
    seen.add(result.check);
    if (!STATUSES.includes(result.status)) { problems.push(`${where}: status must be one of ${STATUSES.join(", ")}`); continue; }
    const executed = result.status === "pass" || result.status === "fail";
    if (executed && !isText(result.observed)) problems.push(`${where}: status ${result.status} needs "observed" (what actually appeared on screen)`);
    if (!executed && !isText(result.reason)) problems.push(`${where}: status ${result.status} needs "reason"`);
    if (executed && check.kind === "irreversible" && result.confirmed !== true) {
      problems.push(`${where}: the check is irreversible; it may only be executed after the owner said yes, recorded as "confirmed": true`);
    }
    if (result.console !== undefined && !(Array.isArray(result.console) && result.console.every(isText))) problems.push(`${where}: "console" must be a list of strings`);
    if (result.network !== undefined) {
      const ok = Array.isArray(result.network) && result.network.every((n) => n && isText(n.url) && Number.isInteger(n.status));
      if (!ok) problems.push(`${where}: each "network" entry needs "url" and an integer "status"`);
    }
  }
  for (const item of Array.isArray(run.created) ? run.created : []) {
    if (!isText(item?.what) || !isText(item?.role)) problems.push('each "created" entry needs "role" and "what"');
  }
  return problems;
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

function loadChecked(checklistFile, runFiles) {
  const list = readJson(checklistFile);
  const problems = validateChecklist(list).map((p) => `${checklistFile}: ${p}`);
  const runs = [];
  if (!problems.length) {
    for (const file of runFiles) {
      const run = readJson(file);
      problems.push(...validateRun(run, list).map((p) => `${file}: ${p}`));
      runs.push(run);
    }
  }
  return { list, runs, problems };
}

function cmdValidate(args) {
  const [checklistFile, ...runFiles] = args;
  if (!checklistFile) throw new UsageError("usage: validate <checklist.json> [run.json...]");
  const list = readJson(checklistFile);
  let failed = 0;
  const report = (file, problems, summary) => {
    if (problems.length) {
      failed++;
      console.log(`FAIL ${file}`);
      for (const problem of problems) console.log(`  - ${problem}`);
    } else console.log(`ok   ${file} (${summary})`);
  };
  const listProblems = validateChecklist(list);
  report(checklistFile, listProblems, `roles ${list.roles?.length ?? 0}, features ${list.features?.length ?? 0}, checks ${list.checks?.length ?? 0}`);
  for (const file of runFiles) {
    if (listProblems.length) { report(file, ["not checked: the checklist itself is invalid"], ""); continue; }
    const run = readJson(file);
    report(file, validateRun(run, list), `results ${run.results?.length ?? 0}`);
  }
  console.log(`${1 + runFiles.length} file(s) checked, ${failed} failed`);
  return failed ? 1 : 0;
}

function selectChecks(list, featureArg, roleArg) {
  const featureIds = new Set(list.features.map((f) => f.id));
  const roleIds = new Set(list.roles.map((r) => r.id));
  const asked = featureArg ? featureArg.split(",").map((s) => s.trim()).filter(Boolean) : [...featureIds];
  for (const id of asked) if (!featureIds.has(id)) throw new UsageError(`unknown feature "${id}"; known: ${[...featureIds].join(", ")}`);
  const roles = roleArg ? roleArg.split(",").map((s) => s.trim()).filter(Boolean) : [...roleIds];
  for (const id of roles) if (!roleIds.has(id)) throw new UsageError(`unknown role "${id}"; known: ${[...roleIds].join(", ")}`);
  const related = new Set();
  for (const feature of list.features) {
    if (asked.includes(feature.id)) for (const other of feature.related || []) if (!asked.includes(other)) related.add(other);
  }
  const wanted = new Set([...asked, ...related]);
  const checks = list.checks.filter((check) => wanted.has(check.feature) && roles.includes(check.role));
  return { checks, related, roles };
}

function cmdPlan(args) {
  const featureArg = option(args, "--feature");
  const roleArg = option(args, "--role");
  const [checklistFile] = args;
  if (!checklistFile) throw new UsageError("usage: plan <checklist.json> [--feature a,b] [--role x,y]");
  const { list, problems } = loadChecked(checklistFile, []);
  if (problems.length) { problems.forEach((p) => console.log(`  - ${p}`)); return 1; }
  const { checks, related, roles } = selectChecks(list, featureArg, roleArg);
  for (const role of list.roles.filter((r) => roles.includes(r.id))) {
    const mine = checks.filter((check) => check.role === role.id);
    if (!mine.length) continue;
    console.log(`\n${role.label} (${role.id}) at ${role.baseUrl}`);
    for (const check of mine) {
      const tags = [check.kind === "irreversible" ? "ASK FIRST" : check.kind, related.has(check.feature) ? "related" : ""].filter(Boolean).join(", ");
      console.log(`  ${check.id}  [${tags}]  ${check.title}`);
      check.steps.forEach((step, index) => console.log(`      ${index + 1}. ${step}`));
      console.log(`      expect: ${check.expect}`);
    }
  }
  console.log(`\n${checks.length} check(s)${related.size ? `, related features included: ${[...related].join(", ")}` : ""}`);
  return 0;
}

const errorLines = (result) => [
  ...(result?.console || []).map((line) => `console: ${line}`),
  ...(result?.network || []).filter((n) => n.status >= 400 || n.status === 0).map((n) => `network: ${n.method || "GET"} ${n.url} -> ${n.status}`),
];

function computeDiff(oldRun, newRun) {
  const before = new Map(oldRun.results.map((r) => [r.check, r]));
  const after = new Map(newRun.results.map((r) => [r.check, r]));
  const out = { from: oldRun.date, to: newRun.date, regressed: [], fixed: [], stillFailing: [], added: [], notRerun: [], newErrors: [] };
  const bad = (status) => status === "fail" || status === "blocked";
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) { out.added.push({ check: id, status: now.status }); continue; }
    const entry = { check: id, was: was.status, now: now.status, observed: now.observed || now.reason || "" };
    if (was.status === "pass" && bad(now.status)) out.regressed.push(entry);
    else if (bad(was.status) && now.status === "pass") out.fixed.push(entry);
    else if (bad(was.status) && bad(now.status)) out.stillFailing.push(entry);
    // Only a check that passed in both runs can gain "new errors". One that went from failing to
    // passing is a fix, and what it recorded (say, an expected 422) is its evidence, not a regression.
    if (now.status === "pass" && was.status === "pass") {
      const known = new Set(errorLines(was));
      const fresh = errorLines(now).filter((line) => !known.has(line));
      if (fresh.length) out.newErrors.push({ check: id, errors: fresh });
    }
  }
  for (const [id, was] of before) if (!after.has(id)) out.notRerun.push({ check: id, was: was.status });
  return out;
}

function cmdDiff(args) {
  const json = flag(args, "--json");
  const [checklistFile, oldFile, newFile] = args;
  if (!newFile) throw new UsageError("usage: diff <checklist.json> <old-run.json> <new-run.json> [--json]");
  const { runs, problems } = loadChecked(checklistFile, [oldFile, newFile]);
  if (problems.length) { problems.forEach((p) => console.error(`  - ${p}`)); return 1; }
  const diff = computeDiff(runs[0], runs[1]);
  if (json) { console.log(JSON.stringify(diff, null, 2)); return 0; }
  const section = (title, items, line) => { console.log(`${title}: ${items.length}`); items.forEach((item) => console.log(`  - ${line(item)}`)); };
  console.log(`swipe ${diff.from} -> ${diff.to}`);
  section("regressed (passed before, not now)", diff.regressed, (i) => `${i.check}: ${i.was} -> ${i.now}. ${i.observed}`);
  section("fixed", diff.fixed, (i) => `${i.check}: ${i.was} -> ${i.now}`);
  section("still failing", diff.stillFailing, (i) => `${i.check}: ${i.now}`);
  section("passing but with new console or network errors", diff.newErrors, (i) => `${i.check}: ${i.errors.join(" | ")}`);
  section("new checks", diff.added, (i) => `${i.check}: ${i.status}`);
  section("in the old run but not run this time", diff.notRerun, (i) => `${i.check}: was ${i.was}`);
  return 0;
}

const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\{\{/g, "{ {");

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
function longDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const STATUS_PILL = {
  pass: '<span class="pill ok">Jalan</span>',
  fail: '<span class="pill danger">Rusak</span>',
  blocked: '<span class="pill warn">Terhalang</span>',
  skipped: '<span class="pill muted">Dilewati</span>',
};

function table(head, rows) {
  const th = head.map((cell) => `<th>${cell}</th>`).join("");
  const body = rows.map((row) => `          <tr>${row.join("")}</tr>`).join("\n");
  return `      <div class="table-scroll"><table>\n        <thead><tr>${th}</tr></thead>\n        <tbody>\n${body}\n        </tbody>\n      </table></div>`;
}

function buildSections(list, run, prev, files) {
  const checks = new Map(list.checks.map((c) => [c.id, c]));
  const features = new Map(list.features.map((f) => [f.id, f]));
  const roles = new Map(list.roles.map((r) => [r.id, r]));
  const results = run.results;
  const count = (status) => results.filter((r) => r.status === status).length;
  const totals = { pass: count("pass"), fail: count("fail"), blocked: count("blocked"), skipped: count("skipped") };
  const ranIds = new Set(results.map((r) => r.check));
  const notRun = list.checks.filter((c) => !ranIds.has(c.id));
  const ranFeatures = [...new Set(results.map((r) => checks.get(r.check).feature))];
  const ranRoles = [...new Set(results.map((r) => checks.get(r.check).role))];
  const failing = results.filter((r) => r.status === "fail");
  const diff = prev ? computeDiff(prev, run) : null;
  const title = (id) => esc(checks.get(id).title);
  // A check is always shown as its title with the id underneath. An id column of its own pushes
  // everything else off a narrow screen.
  const named = (id, extra = "") => `<td><b>${title(id)}</b><br><span class="lbl wrap-ok">${extra ? `${esc(extra)} · ` : ""}${esc(id)}</span></td>`;
  const sections = [];

  // Summary
  const found = [
    `<li><b>${totals.pass} dari ${results.length} pemeriksaan jalan.</b> ${totals.fail} rusak, ${totals.blocked} terhalang, ${totals.skipped} dilewati.</li>`,
    ...failing.slice(0, 4).map((r) => `<li><b>Rusak: ${title(r.check)}</b> (${esc(roles.get(checks.get(r.check).role).label)}). ${esc(r.observed)}</li>`),
  ];
  if (diff) found.push(`<li><b>Dibanding swipe ${esc(prev.scope)}, ${esc(longDate(prev.date))}:</b> ${diff.regressed.length} memburuk, ${diff.fixed.length} membaik, ${diff.newErrors.length} jalan tetapi muncul error baru.</li>`);
  const limits = [
    `<li><b>Cakupan:</b> ${ranFeatures.length} fitur dan ${ranRoles.length} peran. ${notRun.length} pemeriksaan di daftar periksa tidak dijalankan kali ini.</li>`,
    `<li><b>Data yang dibuat:</b> ${(run.created || []).length} butir, tidak dibersihkan otomatis.</li>`,
    ...(run.notes || []).map((note) => `<li>${esc(note)}</li>`),
    "<li><b>Batas laporan:</b> yang tercatat hanya apa yang terlihat di browser saat swipe; isi database tidak diperiksa.</li>",
  ];
  const alarm = totals.fail || (diff && diff.regressed.length)
    ? `\n      <div class="callout warn"><p><b>Baca dulu.</b> ${totals.fail} pemeriksaan rusak${diff ? `, ${diff.regressed.length} di antaranya jalan pada swipe sebelumnya` : ""}. Rinciannya di bagian hasil per peran.</p></div>`
    : "";
  sections.push(["ringkasan", "Ringkasan", null, `      <div class="grid-2">\n        <div class="card"><h4>Yang ditemukan</h4><ul>\n          ${found.join("\n          ")}\n        </ul></div>\n        <div class="card"><h4>Cakupan dan batas</h4><ul>\n          ${limits.join("\n          ")}\n        </ul></div>\n      </div>${alarm}`]);

  // Scope
  const kv = [["Proyek", esc(list.project)], ["Tanggal swipe", esc(longDate(run.date))], ["Yang berjalan", esc(run.basis)], ["Browser", esc(run.browser)]]
    .map(([k, v]) => `        <div><dt>${k}</dt><dd>${v}</dd></div>`).join("\n");
  const roleRows = list.roles.filter((r) => ranRoles.includes(r.id)).map((r) => [`<td>${esc(r.label)}</td>`, `<td><code>${esc(r.baseUrl)}</code></td>`, `<td class="n">${results.filter((x) => checks.get(x.check).role === r.id).length}</td>`]);
  const featureRows = ranFeatures.map((id) => {
    const f = features.get(id);
    return [`<td>${esc(f.label)}</td>`, `<td>${(f.foundIn || []).map((p) => `<code>${esc(p)}</code>`).join(", ") || "tidak dicatat"}</td>`, `<td>${(f.related || []).map((o) => esc(features.get(o).label)).join(", ") || "tidak ada"}</td>`];
  });
  sections.push(["cakupan", "Cakupan", "Apa yang dicoba, sebagai siapa, dan di alamat mana.", `      <dl class="kv">\n${kv}\n      </dl>\n${table(["Peran", "Alamat", "Pemeriksaan"], roleRows)}\n${table(["Fitur", "Ditemukan di", "Fitur terkait"], featureRows)}`]);

  // Changes
  if (diff) {
    const rows = [
      ...diff.regressed.map((i) => [named(i.check), '<td><span class="pill danger">Memburuk</span></td>', `<td>${esc(i.observed)}</td>`]),
      ...diff.newErrors.map((i) => [named(i.check), '<td><span class="pill warn">Error baru</span></td>', `<td>${i.errors.map((e) => `<code>${esc(e)}</code>`).join("<br>")}</td>`]),
      ...diff.fixed.map((i) => [named(i.check), '<td><span class="pill ok">Membaik</span></td>', `<td>${esc(i.observed)}</td>`]),
      ...diff.stillFailing.map((i) => [named(i.check), '<td><span class="pill muted">Masih rusak</span></td>', `<td>${esc(i.observed)}</td>`]),
      ...diff.added.map((i) => [named(i.check), '<td><span class="pill info">Baru</span></td>', "<td>Belum ada di swipe sebelumnya.</td>"]),
      ...diff.notRerun.map((i) => [named(i.check), '<td><span class="pill muted">Tidak diulang</span></td>', "<td>Ada di swipe sebelumnya, tidak dijalankan kali ini.</td>"]),
    ];
    const body = rows.length ? table(["Pemeriksaan", "Perubahan", "Keterangan"], rows) : "      <p>Tidak ada perubahan: tiap pemeriksaan berstatus sama dengan swipe sebelumnya dan tidak ada error baru.</p>";
    sections.push(["perubahan", "Perubahan sejak swipe sebelumnya", `Dibandingkan dengan swipe ${esc(prev.scope)}, ${esc(longDate(prev.date))} (${esc(prev.basis)}).`, body]);
  }

  // Results per role
  const perRole = list.roles.filter((r) => ranRoles.includes(r.id)).map((role) => {
    const rows = results.filter((r) => checks.get(r.check).role === role.id).map((r) => {
      const check = checks.get(r.check);
      const steps = check.steps.map((s) => `<li>${esc(s)}</li>`).join("");
      // The id sits under the title instead of in its own column: a long id column pushes everything
      // else off a narrow screen.
      return [
        `<td><b>${esc(check.title)}</b><br><span class="lbl wrap-ok">${esc(features.get(check.feature).label)} · ${esc(check.id)}</span><ol>${steps}</ol></td>`,
        `<td>${esc(check.expect)}</td>`,
        `<td>${esc(r.observed || r.reason)}</td>`,
        `<td>${STATUS_PILL[r.status]}</td>`,
      ];
    });
    return `      <h3>${esc(role.label)}</h3>\n${table(["Yang dicoba", "Diharapkan", "Yang terjadi", "Status"], rows)}`;
  });
  sections.push(["hasil", "Hasil per peran", "Tiap baris satu pemeriksaan dari daftar periksa, dengan langkah yang dijalankan.", perRole.join("\n")]);

  // Errors
  const errorRows = results.flatMap((r) => errorLines(r).map((line) => [named(r.check, roles.get(checks.get(r.check).role).label), `<td><code>${esc(line)}</code></td>`]));
  sections.push(["error", "Error console dan jaringan", "Yang terbaca dari console browser dan permintaan jaringan selama tiap pemeriksaan.", errorRows.length ? table(["Pemeriksaan", "Error"], errorRows) : "      <p>Tidak ada error console atau permintaan gagal yang tercatat pada pemeriksaan yang dijalankan.</p>"]);

  // Created data
  const createdRows = (run.created || []).map((c) => [`<td>${esc(roles.get(c.role)?.label || c.role)}</td>`, `<td>${esc(c.what)}</td>`, `<td>${c.where ? `<code>${esc(c.where)}</code>` : ""}</td>`]);
  sections.push(["data", "Data yang dibuat selama swipe", "Tidak dibersihkan otomatis. Putuskan sendiri mana yang dihapus.", createdRows.length ? table(["Dibuat sebagai", "Apa", "Di mana"], createdRows) : "      <p>Swipe ini tidak membuat data baru.</p>"]);

  // Not tried
  const idle = [
    ...results.filter((r) => r.status === "skipped" || r.status === "blocked").map((r) => [named(r.check), `<td>${STATUS_PILL[r.status]}</td>`, `<td>${esc(r.reason)}</td>`]),
    ...notRun.map((c) => [named(c.id), '<td><span class="pill muted">Di luar cakupan</span></td>', "<td>Ada di daftar periksa, tidak diminta kali ini.</td>"]),
  ];
  sections.push(["belum", "Yang tidak dicoba", "Supaya tidak dianggap sudah diperiksa.", idle.length ? table(["Pemeriksaan", "Status", "Alasan"], idle) : "      <p>Semua pemeriksaan di daftar periksa dijalankan.</p>"]);

  // Sources
  const sources = [
    ["E1", "Daftar periksa: peran, fitur, langkah, dan harapan", files.checklist],
    ["E2", "Hasil swipe ini", files.run],
    ...(prev ? [["E3", "Hasil swipe pembanding", files.prev]] : []),
  ].map(([id, claim, file]) => [`<td class="id">${id}</td>`, `<td>${claim}</td>`, '<td class="n">0</td>', `<td><code>${esc(file)}</code></td>`, '<td><span class="pill ok">Dibaca utuh</span></td>']);
  sections.push(["bukti", "Daftar sumber", null, table(["ID", "Klaim", "Tier", "Sumber", "Status"], sources)]);

  const html = sections.map(([id, heading, sub, body], index) => {
    const num = String(index).padStart(2, "0");
    return `    <section id="${id}">\n      <h2><span class="num">${num}</span>${heading}</h2>\n${sub ? `      <p class="sub">${sub}</p>\n` : ""}${body}\n    </section>`;
  }).join("\n\n");
  return { html, totals, total: results.length, ranFeatures: ranFeatures.map((id) => features.get(id).label) };
}

function cmdReport(args) {
  const out = option(args, "--out");
  const prevFile = option(args, "--prev");
  const replace = flag(args, "--replace");
  const [checklistFile, runFile] = args;
  if (!runFile || !out) throw new UsageError("usage: report <checklist.json> <run.json> --out <file.html> [--prev <old-run.json>] [--replace]");
  const target = path.resolve(out);
  if (fs.existsSync(target) && !replace) throw new UsageError(`refusing to overwrite existing file: ${target} (pass --replace to regenerate a report from its data)`);
  const { list, runs, problems } = loadChecked(checklistFile, prevFile ? [runFile, prevFile] : [runFile]);
  if (problems.length) {
    console.log("the data has problems; no report written");
    problems.forEach((p) => console.log(`  - ${p}`));
    return 1;
  }
  const [run, prev] = runs;

  // The skeleton always comes from doc-tools, so the style can never drift from the gallery.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "swipe-report-"));
  const draft = path.join(scratch, path.basename(target));
  const made = spawnSync(process.execPath, [DOC_TOOLS, "new", draft], { encoding: "utf8" });
  if (made.status !== 0) throw new UsageError(`doc-tools new failed: ${(made.stdout || "") + (made.stderr || "")}`);
  let html = fs.readFileSync(draft, "utf8");

  const built = buildSections(list, run, prev || null, { checklist: checklistFile, run: runFile, prev: prevFile });
  const start = html.indexOf('<section id="ringkasan">');
  const end = html.indexOf('<footer class="doc">');
  if (start === -1 || end === -1) throw new UsageError("the doc-tools template changed shape: cannot find the summary section or the footer");
  html = `${html.slice(0, start)}${built.html.trimStart()}\n\n    ${html.slice(end)}`;

  const percent = built.total ? Math.round((built.totals.pass / built.total) * 100) : 0;
  const progress = `      <div class="progress">\n        <div class="row"><b>Jalan</b><div class="meter${built.totals.fail ? " warn" : " ok"}"><i style="width:${percent}%"></i></div><span class="lbl">${built.totals.pass} dari ${built.total}</span></div>\n      </div>\n    </header>`;
  const fills = {
    JUDUL_TAB: `Swipe ${longDate(run.date)} · ${list.project}`,
    JENIS: "Swipe", TOPIK: esc(list.project), STATUS: built.totals.fail ? `${built.totals.fail} rusak` : "Semua jalan",
    JUDUL: built.totals.fail ? `${built.totals.fail} dari ${built.total} pemeriksaan rusak di ${esc(built.ranFeatures.join(", "))}` : `${built.total} pemeriksaan jalan di ${esc(built.ranFeatures.join(", "))}`,
    LEDE: `Hasil mencoba aplikasi ${esc(list.project)} lewat browser sebagai tiap peran, pada ${longDate(run.date)}. Disusun dari daftar periksa dan catatan hasil swipe; angka di halaman ini dihitung dari dua berkas itu.`,
    TANGGAL: longDate(run.date), BASIS: esc(run.basis),
    STATUS_RINCI: `${built.totals.pass} jalan, ${built.totals.fail} rusak, ${built.totals.blocked} terhalang, ${built.totals.skipped} dilewati`,
    KAKI: `Dihasilkan swipe-tools dari <code>${esc(path.basename(checklistFile))}</code> dan <code>${esc(path.basename(runFile))}</code> pada ${longDate(run.date)}. Untuk mengubah isinya, ubah datanya lalu buat ulang; jangan menyunting halaman ini.`,
  };
  for (const [key, value] of Object.entries(fills)) html = html.split(`{{${key}}}`).join(value);
  const header = html.indexOf("    </header>");
  if (header === -1) throw new UsageError("the doc-tools template changed shape: cannot find the header end");
  html = html.slice(0, header) + progress + html.slice(header + "    </header>".length);

  fs.writeFileSync(draft, html);
  const checked = spawnSync(process.execPath, [DOC_TOOLS, "check", draft], { encoding: "utf8" });
  if (checked.status !== 0) {
    console.log("the generated report does not pass doc-tools check; nothing written");
    console.log((checked.stdout || "") + (checked.stderr || ""));
    fs.rmSync(scratch, { recursive: true, force: true });
    return 1;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(draft, target);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`report written: ${target}`);
  console.log(`results ${built.total}: pass ${built.totals.pass}, fail ${built.totals.fail}, blocked ${built.totals.blocked}, skipped ${built.totals.skipped}`);
  console.log("next: render it with meta-prd's doc-render and read the images before reporting");
  return 0;
}

function cmdInit(args) {
  const project = option(args, "--project");
  const [dir] = args;
  if (!dir || !project) throw new UsageError("usage: init <project-dir> --project <slug>");
  if (!KEBAB.test(project)) throw new UsageError("--project must be lowercase kebab-case");
  if (!fs.existsSync(dir)) throw new UsageError(`directory not found: ${dir}`);
  const home = path.join(path.resolve(dir), ".swipe");
  const file = path.join(home, "checklist.json");
  if (fs.existsSync(file)) throw new UsageError(`refusing to overwrite existing file: ${file}`);
  fs.mkdirSync(path.join(home, "runs"), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, project, roles: [], features: [], checks: [] }, null, 2)}\n`);
  console.log(`created ${file}`);
  console.log("next: add roles, features, and checks, then run validate");
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const COMMANDS = { init: cmdInit, validate: cmdValidate, plan: cmdPlan, diff: cmdDiff, report: cmdReport };
try {
  if (!COMMANDS[command]) throw new UsageError("usage: swipe-tools.mjs <init|validate|plan|diff|report> ...");
  process.exit(COMMANDS[command](rest));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`error: ${error.message}`);
  process.exit(2);
}
