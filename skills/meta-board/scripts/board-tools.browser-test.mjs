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
    approved_by: "user", user_words: "ok", ...extra,
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
  await shot("range-dialog-1280");
  report("nothing is filtered before Apply", (await visible()) === "#1,#2,#3", await visible());
  await click("[data-range-apply]");
  report("created range keeps the ticket created inside it", (await visible()) === "#2", await visible());
  report("the button shows the chosen range", /4 Nov 2026 – 6 Nov 2026/.test(await browser.evaluate(`document.querySelector("[data-range-open]").textContent`)));

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

  // Phone width: columns stay side by side and the board scrolls sideways.
  await browser.viewport(390, 800);
  await sleep(150);
  const layout = await browser.evaluate(`(() => { const board = document.querySelector(".board"); const cols = [...board.children].map((c) => c.getBoundingClientRect()); return { sameRow: cols.every((c) => Math.abs(c.top - cols[0].top) < 2), scrolls: board.scrollWidth > board.clientWidth + 50, pageWide: document.documentElement.scrollWidth <= innerWidth + 1, width: Math.round(cols[0].width) }; })()`);
  report("on a phone the columns sit side by side and the board scrolls sideways, the page does not", layout.sameRow && layout.scrolls && layout.pageWide, layout);
  await shot("board-390");

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
