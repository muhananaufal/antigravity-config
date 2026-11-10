#!/usr/bin/env node
// Negative controls for `doc-tools check`.
// The unmodified gallery must pass; every mutation below must fail with the expected message.
// A mutation that leaves the file unchanged is reported as NOT APPLIED, so a green run cannot hide a dead test.
//
//   node doc-tools.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "doc-tools.mjs");
const GALLERY = path.join(HERE, "..", "assets", "component-gallery.html");
const TEMPLATE = path.join(HERE, "..", "assets", "doc-template.html");

function replaceOnce(text, from, to) {
  const count = text.split(from).length - 1;
  if (count < 1) throw new Error(`anchor not found: ${from.slice(0, 50)}`);
  return text.replace(from, () => to);
}

const MUTATIONS = [
  ["style tampered", (t) => replaceOnce(t, "--accent: #5b3fd9;", "--accent: #ff0000;"), /style block differs/],
  ["script tampered", (t) => replaceOnce(t, 'button.textContent = "Salin";', 'button.textContent = "Copy";'), /script block differs/],
  ["placeholder left", (t) => replaceOnce(t, "<h1>Semua komponen dalam satu halaman</h1>", "<h1>{{JUDUL}}</h1>"), /placeholder\(s\) left/],
  ["section number skipped", (t) => replaceOnce(t, '<span class="num">03</span>', '<span class="num">13</span>'), /numbered 13, expected 03/],
  ["section without num", (t) => replaceOnce(t, '<h2><span class="num">02</span>Callout</h2>', "<h2>Callout</h2>"), /has no <span class="num">/],
  ["broken anchor", (t) => replaceOnce(t, 'href="#kartu"', 'href="#tidak-ada"'), /link to #tidak-ada has no matching id/],
  ["duplicate id", (t) => replaceOnce(t, '<section id="callout">', '<section id="kartu">'), /duplicate id "kartu"/],
  ["unwrapped table", (t) => replaceOnce(t, '<div class="table-scroll"><table class="compact" id="filter-demo">', '<div><table class="compact" id="filter-demo">'), /table\(s\) not wrapped/],
  ["second h1", (t) => replaceOnce(t, "<h3>Judul tingkat tiga</h3>", "<h1>Judul kedua</h1>"), /exactly one <h1>, found 2/],
  ["external script", (t) => replaceOnce(t, "</body>", '<script src="https://example.com/x.js"></script></body>'), /external <script src>/],
  ["inline style", (t) => replaceOnce(t, '<p class="sub">Selalu dibungkus', '<p class="sub" style="color:red">Selalu dibungkus'), /inline style\(s\)/],
  ["stub marker", (t) => replaceOnce(t, "Dipakai untuk membagi satu bagian", "TBD. Dipakai untuk membagi satu bagian"), /TODO\/TBD\/FIXME/],
  ["toc removed", (t) => t.split("<ol data-toc></ol>").join("<ol></ol>"), /missing <ol data-toc>/],
];

function run(file) {
  try {
    return { code: 0, out: execFileSync("node", [TOOL, "check", file], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || "") + String(error.stderr || "") };
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-tools-test-"));
const base = fs.readFileSync(GALLERY, "utf8");
let problems = 0;
let caught = 0;

const control = run(GALLERY);
console.log(`${control.code === 0 ? "ok    " : "FAIL  "} control: unmodified gallery passes (exit ${control.code})`);
if (control.code !== 0) problems++;

const template = run(TEMPLATE);
const templateOk = template.code === 1 && /placeholder\(s\) left/.test(template.out) && !/block differs/.test(template.out);
console.log(`${templateOk ? "ok    " : "FAIL  "} template: fails only on placeholders, style and script in sync (exit ${template.code})`);
if (!templateOk) { problems++; console.log(template.out); }

for (const [name, mutate, expected] of MUTATIONS) {
  const mutated = mutate(base);
  if (mutated === base) { console.log(`FAIL   NOT APPLIED: ${name}`); problems++; continue; }
  const file = path.join(dir, `${name.replace(/\W+/g, "-")}.html`);
  fs.writeFileSync(file, mutated);
  const result = run(file);
  const ok = result.code === 1 && expected.test(result.out);
  console.log(`${ok ? "ok    " : "FAIL  "} mutation caught: ${name} (exit ${result.code})`);
  if (ok) caught++; else { problems++; console.log(result.out.split("\n").slice(0, 6).join("\n")); }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`mutations ${MUTATIONS.length}, caught ${caught}, problems ${problems}`);
process.exit(problems ? 1 : 0);
