#!/usr/bin/env node
// Renders a document in a real headless browser and writes readable screenshots:
// light and dark at desktop width, light and dark at phone width, each cut into viewport-high slices.
//
//   node doc-render.mjs <file.html> [--out <dir>] [--only light|dark] [--width 1280,390]
//
// Prints one line per combination with overflow and script-error findings, then the image paths.
// Exit 0 = rendered without findings, 1 = a finding (horizontal overflow, script error, diagram stuck),
// 3 = no browser found (nothing was rendered; that is not a pass).
import fs from "node:fs";
import path from "node:path";
import { launch, findBrowser, sleep } from "./lib/browser.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out" && args[args.indexOf(a) - 1] !== "--only" && args[args.indexOf(a) - 1] !== "--width");
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
if (!file) {
  console.error("usage: doc-render.mjs <file.html> [--out <dir>] [--only light|dark] [--width 1280,390]");
  process.exit(2);
}
const target = path.resolve(file);
if (!fs.existsSync(target)) {
  console.error(`file not found: ${target}`);
  process.exit(2);
}
if (!findBrowser()) {
  console.log("NO BROWSER: no Edge or Chrome found; set DOC_BROWSER. Nothing was rendered.");
  process.exit(3);
}

const baseName = path.basename(target, path.extname(target));
const outDir = path.resolve(option("--out", path.join(path.dirname(target), `${baseName}-render`)));
const schemes = option("--only", "") ? [option("--only")] : ["light", "dark"];
const widths = option("--width", "1280,390").split(",").map((w) => Number(w.trim())).filter((w) => w >= 200);
const SLICE = 1400;
const MAX_SLICES = 40;

fs.mkdirSync(outDir, { recursive: true });
for (const old of fs.readdirSync(outDir)) {
  if (old.startsWith(`${baseName}-`) && old.endsWith(".png")) fs.rmSync(path.join(outDir, old));
}

let findings = 0;
const written = [];
const browser = await launch();
try {
  for (const scheme of schemes) {
    for (const width of widths) {
      await browser.colorScheme(scheme);
      await browser.viewport(width, 900);
      await browser.open(target);
      // A stored theme choice would override the emulated scheme; rendering must show the scheme asked for.
      await browser.evaluate(`document.documentElement.removeAttribute("data-theme"); document.dispatchEvent(new CustomEvent("doc:theme")); true`);
      const diagrams = await browser.settleDiagrams();
      await sleep(250);
      const info = await browser.evaluate(`({
        height: Math.ceil(document.documentElement.scrollHeight),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        sections: document.querySelectorAll("main section[id]").length,
        toc: document.querySelectorAll("nav.toc a").length
      })`);
      const notes = [];
      if (info.scrollWidth > info.innerWidth) { findings++; notes.push(`HORIZONTAL OVERFLOW ${info.scrollWidth}px > ${info.innerWidth}px`); }
      if (info.scheme !== scheme) { findings++; notes.push(`scheme is ${info.scheme}, expected ${scheme}`); }
      if (info.sections > 0 && info.toc !== info.sections) { findings++; notes.push(`table of contents has ${info.toc} links for ${info.sections} sections`); }
      if (diagrams.includes("pending")) { findings++; notes.push("a diagram never finished"); }
      if (diagrams.includes("failed")) notes.push("diagram shown as source text (library not loaded)");

      const slices = Math.min(MAX_SLICES, Math.ceil(info.height / SLICE));
      if (Math.ceil(info.height / SLICE) > MAX_SLICES) notes.push(`page is ${info.height}px tall; only the first ${MAX_SLICES} slices were written`);
      for (let i = 0; i < slices; i++) {
        const y = i * SLICE;
        const height = Math.min(SLICE, info.height - y);
        const name = `${baseName}-${scheme}-${width}-${String(i + 1).padStart(2, "0")}.png`;
        await browser.screenshot(path.join(outDir, name), { x: 0, y, width, height });
        written.push(name);
      }
      console.log(`${scheme.padEnd(5)} ${String(width).padStart(4)}px  height ${info.height}px, ${slices} slice(s), sections ${info.sections}, diagrams ${diagrams.length}${notes.length ? "  !! " + notes.join("; ") : ""}`);
    }
  }
  if (browser.pageErrors.length) {
    findings++;
    console.log(`SCRIPT ERRORS (${browser.pageErrors.length}): ${browser.pageErrors.slice(0, 3).join(" | ")}`);
  }
} catch (error) {
  findings++;
  console.log(`render aborted: ${error.message}`);
} finally {
  browser.close();
}

console.log(`${written.length} image(s) in ${outDir}`);
console.log(findings ? `${findings} finding(s). Read the images before reporting.` : "no findings from the automatic checks. Now read the images: the checks do not see ugly or unreadable.");
process.exit(findings ? 1 : 0);
