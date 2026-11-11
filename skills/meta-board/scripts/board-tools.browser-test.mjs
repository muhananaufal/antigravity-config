#!/usr/bin/env node
// Opens a generated board in a real headless browser and uses its filters: project, title search,
// date range (created and updated), the calendar's keys, and the sideways scroll.
// The board is built from a throwaway database, never the real one.
//
//   node board-tools.browser-test.mjs [--shots <dir>]
//
// Exit 0 = all checks passed, 1 = a check failed, 3 = no browser found (nothing was tested; not a pass).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch, findBrowser, sleep } from "../../meta-prd/scripts/lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "board-tools.mjs");
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : path.resolve(process.argv[shotsAt + 1] || "shots");

if (!findBrowser()) {
  console.log("NO BROWSER: no Edge or Chrome found; set DOC_BROWSER. Nothing was tested.");
  process.exit(3);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "board-browser-test-"));
const DB = path.join(TMP, "board.db");
function tool(args, at) {
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], { encoding: "utf8", env: { ...process.env, AETHERIS_BOARD: DB, BOARD_NOW: at } });
  if (out.status !== 0) throw new Error(`board-tools ${args.join(" ")} failed:\n${out.stdout}${out.stderr}`);
}
let counter = 0;
function add(project, title, at, extra = {}) {
  const dir = path.join(TMP, "work", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(TMP, `ticket-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify({
    title, summary: "A ticket made for the browser test, with a summary long enough to be accepted.",
    done_when: ["The filter shows or hides this card as expected."], sources: [{ claim: "Made for the test", source: "board-tools.browser-test.mjs" }],
    approved_by: "user", user_words: "ok", type: "feature", ...extra,
  }));
  tool(["add", "--file", file, "--dir", dir], at);
}

// Created on three different days; ticket 2 is updated later than it was created.
add("alpha", "Export claims to Excel", "2026-11-02T09:00:00+07:00");
add("alpha", "Claim limit per month", "2026-11-05T09:00:00+07:00");
add("beta", "Excel import for employees", "2026-11-09T09:00:00+07:00");
tool(["set", "2", "--status", "doing"], "2026-11-20T09:00:00+07:00");
const site = path.join(TMP, "site");
tool(["report", "--out", site], "2026-11-21T09:00:00+07:00");

let failed = 0;
function report(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "ok    " : "FAIL  "} ${name}${detail !== undefined && !ok ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
}

const browser = await launch();
try {
  await browser.viewport(1280, 900);
  await browser.colorScheme("light");
  await browser.open(path.join(site, "index.html"));
  const visible = () => browser.evaluate(`[...document.querySelectorAll("a.ticket")].filter((a) => !a.hidden).map((a) => a.querySelector("h4").textContent.split(" · ")[0]).sort().join(",")`);
  const click = (selector) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (name) => browser.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const size = await browser.evaluate(`({ width: innerWidth, height: Math.max(innerHeight, document.documentElement.scrollHeight) })`);
    await browser.screenshot(path.join(SHOTS, `${name}.png`), { x: 0, y: 0, ...size });
  };

  report("all three tickets show at first", (await visible()) === "#1,#2,#3", await visible());
  await shot("board-1280");

  // The filters sit in one row on a wide screen.
  const row = await browser.evaluate(`(() => { const tops = ["[data-project-open]", "[data-title-search]", "[data-date-field]", "[data-range-open]"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }); return Math.max(...tops) - Math.min(...tops); })()`);
  report("project picker, title search, date field and range share one row", row <= 4, row);
  const gaps = await browser.evaluate(`(() => { const boxes = ["[data-project-open]", "[data-title-search]", '[data-date-field="created"]', '[data-date-field="updated"]', "[data-range-open]"].map((s) => document.querySelector(s).getBoundingClientRect()); return boxes.slice(1).map((b, i) => Math.round(b.left - boxes[i].right)); })()`);
  report("the five filter controls are evenly spaced", gaps.every((gap) => gap === gaps[0]) && gaps[0] >= 10, gaps);
  report("the Filters and Board headings take no room", await browser.evaluate(`[...document.querySelectorAll("section.bare > h2")].every((h) => h.getBoundingClientRect().width <= 1)`));

  // The project picker: opens, narrows as you type, picks with the keyboard, closes with Escape.
  const typeInto = (selector, text) => browser.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const listed = () => browser.evaluate(`[...document.querySelectorAll("[data-project-panel] [role=option]")].filter((b) => !b.parentNode.hidden).map((b) => b.textContent).join("|")`);
  report("the project list starts closed", await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`));
  await click("[data-project-open]");
  report("the picker opens with the search box focused", await browser.evaluate(`!document.querySelector("[data-project-panel]").hidden && document.activeElement.matches("[data-project-search]")`));
  await typeInto("[data-project-search]", "BET");
  report("typing narrows the project list", (await listed()) === "work / beta", await listed());
  await typeInto("[data-project-search]", "zzz");
  report("no match says so", (await listed()) === "" && !(await browser.evaluate(`document.querySelector("[data-project-none]").hidden`)));
  await typeInto("[data-project-search]", "bet");
  await key("Enter");
  report("Enter picks the first match and closes the list", (await visible()) === "#3" && (await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`)) && /work \/ beta/.test(await browser.evaluate(`document.querySelector("[data-project-open]").textContent`)), await visible());
  await click("[data-project-open]");
  await key("ArrowDown");
  await key("ArrowDown");
  report("arrow keys walk the options", (await browser.evaluate(`document.activeElement.getAttribute("data-board-filter")`)) === "alpha");
  await key("Escape");
  report("Escape closes without changing the choice", (await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`)) && (await visible()) === "#3", await visible());
  await click("[data-project-open]");
  await browser.evaluate(`document.querySelector("h1").click()`);
  report("a click outside closes the list", await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`));
  await shot("picker-closed-1280");

  await click('[data-board-filter="alpha"]');
  report("project filter keeps only that project", (await visible()) === "#1,#2", await visible());
  report("column counters follow the filter", (await browser.evaluate(`[...document.querySelectorAll("[data-count]")].reduce((sum, b) => sum + Number(b.textContent), 0)`)) === 2);
  await click('[data-board-filter=""]');

  await browser.evaluate(`(() => { const box = document.querySelector("[data-title-search]"); box.value = "excel  EXPORT"; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  report("title search matches every word, any order, any case", (await visible()) === "#1", await visible());
  await browser.evaluate(`(() => { const box = document.querySelector("[data-title-search]"); box.value = "excel"; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  report("title search with one word finds both", (await visible()) === "#1,#3", await visible());
  await browser.evaluate(`(() => { const box = document.querySelector("[data-title-search]"); box.value = ""; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);

  // Date range on the created date: pick 4 Nov, then 6 Nov.
  await click("[data-range-open]");
  report("the range dialog opens", await browser.evaluate(`document.querySelector("dialog[data-range]").open`));
  for (let i = 0; i < 24 && !(await browser.evaluate(`Boolean(document.querySelector('[data-day="2026-11-04"]'))`)); i++) {
    const first = await browser.evaluate(`document.querySelector("[data-day]").getAttribute("data-day")`);
    await click(`[data-range-shift="${first > "2026-11-04" ? -1 : 1}"]`);
  }
  await click('[data-day="2026-11-04"]');
  await click('[data-day="2026-11-06"]');
  report("two clicks mark the ends and the days between", await browser.evaluate(`document.querySelector('[data-day="2026-11-04"]').classList.contains("edge") && document.querySelector('[data-day="2026-11-05"]').classList.contains("in-range") && document.querySelector('[data-day="2026-11-06"]').classList.contains("edge")`));
  const fit = await browser.evaluate(`(() => { const d = document.querySelector("dialog.range").getBoundingClientRect(); return [...document.querySelectorAll("dialog.range table, dialog.range .range-row, dialog.range .chips")].every((el) => { const r = el.getBoundingClientRect(); return r.left >= d.left - 1 && r.right <= d.right + 1; }); })()`);
  report("everything in the dialog fits inside it", fit);
  const rhythm = await browser.evaluate(`(() => { const d = document.querySelector("dialog.range"); const blocks = [...d.children].map((c) => c.getBoundingClientRect()); const between = blocks.slice(1).map((b, i) => Math.round(b.top - blocks[i].bottom)); const gapOf = (sel) => { const b = [...d.querySelectorAll(sel)].map((el) => el.getBoundingClientRect()); return b.slice(1).map((x, i) => Math.round(x.left - b[i].right)); }; return { between, presets: gapOf("[data-range-preset]"), arrows: gapOf("[data-range-shift]"), actions: gapOf("[data-range-cancel], [data-range-apply]") }; })()`);
  report("the dialog keeps one rhythm between its blocks and between its buttons", rhythm.between.every((gap) => gap === 20) && [...rhythm.presets, ...rhythm.arrows, ...rhythm.actions].every((gap) => gap === 12), rhythm);
  await shot("range-dialog-1280");
  report("nothing is filtered before Apply", (await visible()) === "#1,#2,#3", await visible());
  await click("[data-range-apply]");
  report("created range keeps the ticket created inside it", (await visible()) === "#2", await visible());
  report("the button shows the chosen range", (await browser.evaluate(`document.querySelector("[data-range-open] .range-long").textContent`)) === "4 Nov 2026 – 6 Nov 2026" && (await browser.evaluate(`getComputedStyle(document.querySelector("[data-range-open] .range-short")).display`)) === "none");

  await click('[data-date-field="updated"]');
  report("the same range on the updated date hides a ticket updated later", (await visible()) === "", await visible());
  await click('[data-date-field="created"]');

  // Keyboard: from the focused end day, ArrowRight then Enter starts a new range one day later.
  await click("[data-range-open]");
  const focusedBefore = await browser.evaluate(`document.activeElement.getAttribute("data-day")`);
  await key("ArrowRight");
  const focusedAfter = await browser.evaluate(`document.activeElement.getAttribute("data-day")`);
  report("the dialog opens with the range start focused, and ArrowRight moves one day", focusedBefore === "2026-11-04" && focusedAfter === "2026-11-05", `${focusedBefore} -> ${focusedAfter}`);
  await key("PageDown");
  report("PageDown moves one month and keeps the day in view", (await browser.evaluate(`document.activeElement.getAttribute("data-day")`)) === "2026-12-05");
  await click("[data-range-cancel]");
  report("Cancel leaves the applied range alone", (await visible()) === "#2", await visible());

  // Presets, then Clear.
  await click("[data-range-open]");
  await click('[data-range-preset="last7"]');
  report("a preset fills both ends", await browser.evaluate(`document.querySelectorAll("[data-range-grid] .edge").length >= 1`));
  await click("[data-range-clear]");
  await click("[data-range-apply]");
  report("Clear then Apply removes the range", (await visible()) === "#1,#2,#3" && /Any date/.test(await browser.evaluate(`document.querySelector("[data-range-open]").textContent`)), await visible());

  // Filters are remembered across a reload.
  await click('[data-board-filter="beta"]');
  await browser.open(path.join(site, "index.html"));
  report("the chosen project survives a reload", (await visible()) === "#3", await visible());
  await click('[data-board-filter=""]');

  // Phone width, with the longest labels the row can get: a project chosen and a date range applied.
  await browser.evaluate(`localStorage.setItem("board-filters", JSON.stringify({ project: "alpha", field: "created", from: "2026-11-01", to: "2026-11-30", title: "" }))`);
  await browser.viewport(390, 800);
  await browser.open(path.join(site, "index.html"));
  await sleep(150);
  report("on a phone the range label drops the year", (await browser.evaluate(`getComputedStyle(document.querySelector("[data-range-open] .range-long")).display`)) === "none" && (await browser.evaluate(`document.querySelector("[data-range-open] .range-short").textContent`)) === "1 Nov – 30 Nov");
  const layout = await browser.evaluate(`(() => { const board = document.querySelector(".board"); const cols = [...board.children].map((c) => c.getBoundingClientRect()); return { sameRow: cols.every((c) => Math.abs(c.top - cols[0].top) < 2), scrolls: board.scrollWidth > board.clientWidth + 50, pageWide: document.documentElement.scrollWidth <= innerWidth + 1, width: Math.round(cols[0].width) }; })()`);
  report("on a phone the columns sit side by side and the board scrolls sideways, the page does not", layout.sameRow && layout.scrolls && layout.pageWide, layout);
  const phone = await browser.evaluate(`(() => { const box = (s) => document.querySelector(s).getBoundingClientRect(); const search = box("[data-title-search]"); const rest = ["[data-project-open]", "[data-date-field]", "[data-range-open]"].map(box); return { searchFirst: rest.every((r) => r.top > search.bottom - 1), restOneRow: Math.max(...rest.map((r) => r.top)) - Math.min(...rest.map((r) => r.top)) <= 4, fits: rest.every((r) => r.right <= innerWidth) && search.right <= innerWidth, searchWide: search.width > innerWidth * 0.8 }; })()`);
  report("on a phone the title search takes the first row and the other three share the second", phone.searchFirst && phone.restOneRow && phone.fits && phone.searchWide, phone);
  await click("[data-project-open]");
  const panel = await browser.evaluate(`(() => { const r = document.querySelector("[data-project-panel]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
  report("on a phone the project list stays inside the screen", panel);
  await shot("board-390");
  await key("Escape");

  await browser.viewport(1280, 900);
  await browser.colorScheme("dark");
  await browser.open(path.join(site, "ticket-2.html"));
  report("ticket page shows created and updated dates", /Created\s*5 Nov 2026/.test(await browser.evaluate(`document.querySelector("header.doc").textContent`)) && /Updated\s*20 Nov 2026/.test(await browser.evaluate(`document.querySelector("header.doc").textContent`)));
  await click('[data-theme-set="light"]');
  report("the theme switch works from inside the header", (await browser.evaluate(`document.documentElement.getAttribute("data-theme")`)) === "light");
  await shot("ticket-1280");

  report("no script errors on any page", browser.pageErrors.length === 0, browser.pageErrors.slice(0, 3));
} finally {
  browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failure(s)` : "\nall checks passed");
process.exit(failed ? 1 : 0);
