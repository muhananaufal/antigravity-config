#!/usr/bin/env node
// doc-tools: keeps HTML documents on the shared doc-style.
//
//   node doc-tools.mjs new <out.html>        copy the template to a new document (refuses to overwrite)
//   node doc-tools.mjs check <file.html>...  verify a document: shared style/script intact, no placeholders,
//                                            numbered sections, anchors resolve, tables wrapped
//   node doc-tools.mjs sync [file.html]...   copy style + script from the gallery into the template and the given files
//
// The gallery (assets/component-gallery.html) is the single source of the style and script blocks.
// No dependencies; Node 18+.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, "..", "assets");
const GALLERY = path.join(ASSETS, "component-gallery.html");
const TEMPLATE = path.join(ASSETS, "doc-template.html");

const BLOCKS = [
  { name: "style", re: /(<style id="doc-style">)([\s\S]*?)(<\/style>)/ },
  { name: "script", re: /(<script id="doc-script">)([\s\S]*?)(<\/script>)/ },
];
const ALLOWED_IMPORT = "https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs";

const normalize = (text) => text.replace(/\r\n/g, "\n").trim();

function readFile(file) {
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) throw new Error(`file is empty: ${file}`);
  return text;
}

function block(html, spec, file) {
  const match = spec.re.exec(html);
  if (!match) throw new Error(`${file}: missing <${spec.name} id="doc-${spec.name}"> block`);
  return match[2];
}

function sourceBlocks() {
  const gallery = readFile(GALLERY);
  const out = {};
  for (const spec of BLOCKS) {
    out[spec.name] = block(gallery, spec, GALLERY);
    if (normalize(out[spec.name]).length < 500) throw new Error(`gallery ${spec.name} block is suspiciously small`);
  }
  return out;
}

function sync(files) {
  const source = sourceBlocks();
  const targets = [TEMPLATE, ...files.map((f) => path.resolve(f))];
  for (const target of targets) {
    let html = readFile(target);
    for (const spec of BLOCKS) {
      block(html, spec, target);
      html = html.replace(spec.re, (_, open, __, close) => open + source[spec.name] + close);
    }
    fs.writeFileSync(target, html);
    console.log(`synced ${target} (${html.length} bytes)`);
  }
}

function create(out) {
  if (!out) throw new Error("usage: new <out.html>");
  const target = path.resolve(out);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing file: ${target}`);
  const template = readFile(TEMPLATE);
  const source = sourceBlocks();
  for (const spec of BLOCKS) {
    if (normalize(block(template, spec, TEMPLATE)) !== normalize(source[spec.name])) {
      throw new Error(`template ${spec.name} block is out of date; run "sync" first`);
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, template);
  console.log(`created ${target}`);
  console.log("next: replace every {{...}} placeholder, add sections with components from references/components.md, then run check");
}

function stripBlocks(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
}

function checkOne(file, source) {
  const problems = [];
  const html = readFile(file);
  const body = stripBlocks(html);

  const base = path.basename(file);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*\.html$/.test(base)) {
    problems.push(`file name "${base}" is not lowercase kebab-case ending in .html (see the naming table in SKILL.md)`);
  }

  for (const spec of BLOCKS) {
    const match = spec.re.exec(html);
    if (!match) { problems.push(`missing <${spec.name} id="doc-${spec.name}"> block`); continue; }
    if (normalize(match[2]) !== normalize(source[spec.name])) {
      problems.push(`${spec.name} block differs from the gallery (do not hand-edit it; page-specific rules go in a separate <style id="page-style">)`);
    }
  }

  const placeholders = body.match(/\{\{[^}]*\}\}/g) || [];
  if (placeholders.length) problems.push(`${placeholders.length} placeholder(s) left, e.g. ${placeholders.slice(0, 3).join(" ")}`);
  if (/lorem ipsum/i.test(body)) problems.push("lorem ipsum text left in the document");
  const stubs = body.match(/\b(TODO|TBD|FIXME)\b/g) || [];
  if (stubs.length) problems.push(`${stubs.length} TODO/TBD/FIXME marker(s) left`);

  if (!/<html[^>]*\blang="[a-z-]+"/i.test(html)) problems.push("<html> has no lang attribute");
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (!title || !title[1].trim()) problems.push("empty <title>");
  const h1 = body.match(/<h1[\s>]/g) || [];
  if (h1.length !== 1) problems.push(`expected exactly one <h1>, found ${h1.length}`);
  if (!/<header class="doc">/.test(body)) problems.push('missing <header class="doc">');
  if (!/<ol data-toc>/.test(body)) problems.push("missing <ol data-toc> (the table of contents is generated from the sections)");

  const sections = [...body.matchAll(/<section id="([^"]*)"[^>]*>\s*(?:<div class="[^"]*">\s*)?<h2>(?:<span class="num">([^<]*)<\/span>)?/g)];
  const sectionCount = (body.match(/<section[\s>]/g) || []).length;
  if (sectionCount === 0) problems.push("no <section> found");
  if (sections.length !== sectionCount) problems.push(`${sectionCount - sections.length} section(s) lack an id or do not start with <h2>`);
  sections.forEach((match, index) => {
    const expected = String(index).padStart(2, "0");
    if (match[2] === undefined) problems.push(`section #${match[1]} has no <span class="num"> in its <h2>`);
    else if (match[2] !== expected) problems.push(`section #${match[1]} is numbered ${match[2]}, expected ${expected}`);
  });

  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate id "${id}"`);
    seen.add(id);
  }
  const anchors = [...body.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
  for (const anchor of new Set(anchors)) {
    if (!seen.has(anchor)) problems.push(`link to #${anchor} has no matching id`);
  }

  const tables = (body.match(/<table[\s>]/g) || []).length;
  const wrapped = (body.match(/class="table-scroll[^"]*">\s*<table[\s>]/g) || []).length;
  if (wrapped < tables) problems.push(`${tables - wrapped} table(s) not wrapped directly in <div class="table-scroll">`);

  const externalScripts = html.match(/<script[^>]*\bsrc=/g) || [];
  if (externalScripts.length) problems.push(`${externalScripts.length} external <script src> (documents must stay self-contained)`);
  const imports = [...html.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]).filter((u) => u !== ALLOWED_IMPORT);
  if (imports.length) problems.push(`unexpected dynamic import: ${imports.join(", ")}`);

  const inlineStyles = (body.match(/\sstyle="[^"]*"/g) || []).filter((s) => !/^\sstyle="(\s*(width|--[a-z-]+)\s*:[^;"]+;?)+\s*"$/.test(s));
  if (inlineStyles.length) problems.push(`${inlineStyles.length} inline style(s) beyond width or custom properties, e.g. ${inlineStyles[0].trim()}`);

  const summary = `sections ${sections.length}, ids ${ids.length}, internal links ${anchors.length}, tables ${tables}`;
  return { problems, summary };
}

function check(files) {
  if (!files.length) throw new Error("usage: check <file.html>...");
  const source = sourceBlocks();
  let failed = 0;
  for (const file of files) {
    const target = path.resolve(file);
    const { problems, summary } = checkOne(target, source);
    if (problems.length) {
      failed++;
      console.log(`FAIL ${target} (${summary})`);
      for (const problem of problems) console.log(`  - ${problem}`);
    } else {
      console.log(`ok   ${target} (${summary})`);
    }
  }
  console.log(`${files.length} file(s) checked, ${failed} failed`);
  if (failed) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "sync") sync(rest);
  else if (command === "check") check(rest);
  else if (command === "new") create(rest[0]);
  else {
    console.error("usage: doc-tools.mjs <new|check|sync> ...");
    process.exit(2);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(2);
}
