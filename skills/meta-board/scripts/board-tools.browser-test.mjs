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
let board = DB;
function tool(args, at) {
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], { encoding: "utf8", env: { ...process.env, AETHERIS_BOARD: board, BOARD_NOW: at } });
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
tool(["set", "work-alpha-2", "--status", "doing"], "2026-11-20T09:00:00+07:00");
const site = path.join(TMP, "site");
tool(["report", "--out", site], "2026-11-21T09:00:00+07:00");

// A second board with one crowded column, for "show more".
// It lives in its own folder: the pages are kept beside the board file, and two boards must not share one "site".
const CROWDED_DB = path.join(TMP, "crowded-board", "board.db");
fs.mkdirSync(path.dirname(CROWDED_DB), { recursive: true });
board = CROWDED_DB;
for (let i = 1; i <= 23; i++) add("gamma", `Bulk ticket number ${String(i).padStart(2, "0")}`, `2026-10-${String(i).padStart(2, "0")}T09:00:00+07:00`);
const crowded = path.join(TMP, "crowded-board", "site");
board = DB;

let failed = 0;
function report(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "ok    " : "FAIL  "} ${name}${detail !== undefined && !ok ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
}

const browser = await launch();
try {
  await browser.viewport(1280, 900);
  await browser.colorScheme("light");
  // The page draws itself from data.js after loading, so a check waits until the view is there.
  const drawn = async (probe) => { for (let i = 0; i < 80; i++) { if (await browser.evaluate(probe).catch(() => false)) return true; await sleep(100); } return false; };
  const openBoard = async (file) => { await browser.open(file); await drawn("Boolean(window.__board) && Boolean(document.querySelector('.board'))"); };
  const openTicket = async (dir, key) => { await browser.open(path.join(dir, "index.html")); await drawn("Boolean(window.__board)"); await browser.evaluate(`location.hash = ${JSON.stringify("#" + key)}`); await drawn(`document.body.classList.contains("view-ticket")`); };
  await openBoard(path.join(site, "index.html"));
  const visible = () => browser.evaluate(`[...document.querySelectorAll("a.ticket")].filter((a) => !a.hidden).map((a) => a.querySelector("h4").textContent.split(" · ")[0]).sort().join(",")`);
  const click = (selector) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (name) => browser.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const size = await browser.evaluate(`({ width: innerWidth, height: Math.max(innerHeight, document.documentElement.scrollHeight) })`);
    await browser.screenshot(path.join(SHOTS, `${name}.png`), { x: 0, y: 0, ...size });
  };

  report("all three tickets show at first", (await visible()) === "work-alpha-1,work-alpha-2,work-beta-1", await visible());
  await shot("board-1280");

  // Sorting: the Ready column holds #1 (2 Nov, "Export claims to Excel") and #3 (9 Nov, "Excel import for employees").
  const ready = () => browser.evaluate(`[...[...document.querySelectorAll("[data-column]")].find((c) => c.querySelector("h3").textContent.startsWith("Ready")).querySelectorAll("a.ticket")].filter((a) => !a.hidden).map((a) => a.getAttribute("data-id")).join(",")`);
  const sortBy = (field) => browser.evaluate(`document.querySelector(${JSON.stringify(`[data-sort-option="${field}"]`)}).click()`);
  const sortNow = () => browser.evaluate(`document.querySelector("[data-sort-option][aria-selected=true]").getAttribute("data-value") + "|" + document.querySelector("[data-sort-open]").textContent`);
  report("cards start sorted by last update, newest first", (await ready()) === "3,1" && (await sortNow()) === "updated|Sort: updated", await ready());
  await click("[data-sort-dir]");
  report("the direction button flips the order", (await ready()) === "1,3" && /ascending/i.test(await browser.evaluate(`document.querySelector("[data-sort-dir]").getAttribute("aria-label")`)), await ready());
  await sortBy("title");
  report("sorting by title, ascending", (await ready()) === "3,1", await ready());
  await click("[data-sort-dir]");
  report("sorting by title, descending", (await ready()) === "1,3", await ready());
  await sortBy("number");
  report("sorting by ticket number, descending", (await ready()) === "3,1", await ready());
  await sortBy("created");
  await click("[data-sort-dir]");
  report("sorting by created date, ascending", (await ready()) === "1,3", await ready());
  await openBoard(path.join(site, "index.html"));
  report("the chosen sort survives a reload", (await ready()) === "1,3" && (await sortNow()) === "created|Sort: created", await ready());
  await sortBy("updated");
  await click("[data-sort-dir]");

  // The filters sit in one row on a wide screen.
  const row = await browser.evaluate(`(() => { const tops = ["[data-project-open]", "[data-title-search]", "[data-range-open]", "[data-sort-open]", "[data-sort-dir]"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }); return Math.max(...tops) - Math.min(...tops); })()`);
  report("project picker, title search, date range and sort share one row", row <= 4, row);
  const gaps = await browser.evaluate(`(() => { const boxes = ["[data-project-open]", "[data-title-search]", "[data-range-open]", "[data-sort-open]", "[data-sort-dir]"].map((s) => document.querySelector(s).getBoundingClientRect()); return boxes.slice(1).map((b, i) => Math.round(b.left - boxes[i].right)); })()`);
  report("the filter controls are evenly spaced", gaps.every((gap) => gap === gaps[0]) && gaps[0] >= 10, gaps);
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
  report("Enter picks the first match and closes the list", (await visible()) === "work-beta-1" && (await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`)) && /work \/ beta/.test(await browser.evaluate(`document.querySelector("[data-project-open]").textContent`)), await visible());
  await click("[data-project-open]");
  await key("ArrowDown");
  await key("ArrowDown");
  report("arrow keys walk the options", (await browser.evaluate(`document.activeElement.getAttribute("data-board-filter")`)) === "work-alpha");
  await key("Escape");
  report("Escape closes without changing the choice", (await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`)) && (await visible()) === "work-beta-1", await visible());
  await click("[data-project-open]");
  await browser.evaluate(`document.querySelector("h1").click()`);
  report("a click outside closes the list", await browser.evaluate(`document.querySelector("[data-project-panel]").hidden`));
  // The sort choice is the same kind of dropdown as the project one, not the browser's own select.
  report("there is no native select on the page", (await browser.evaluate(`document.querySelectorAll("select").length`)) === 0);
  await click("[data-sort-open]");
  const sortPanel = await browser.evaluate(`(() => { const p = document.querySelector("[data-sort-panel]"); const a = getComputedStyle(document.querySelector("[data-sort-open]"), "::after").content; const b = getComputedStyle(document.querySelector("[data-project-open]"), "::after").content; return { open: !p.hidden, options: [...p.querySelectorAll("[role=option]")].map((o) => o.textContent).join("|"), sameArrow: a === b && a !== "none", focused: document.activeElement.getAttribute("data-sort-option") }; })()`);
  report("the sort dropdown opens on the current choice, with the same arrow as the project dropdown", sortPanel.open && sortPanel.options === "Updated|Created|Title|Ticket number" && sortPanel.sameArrow && sortPanel.focused === "updated", sortPanel);
  await shot("sort-open-1280");
  await key("Escape");
  report("Escape closes the sort dropdown", await browser.evaluate(`document.querySelector("[data-sort-panel]").hidden`));
  await shot("picker-closed-1280");

  await click('[data-board-filter="work-alpha"]');
  report("project filter keeps only that project", (await visible()) === "work-alpha-1,work-alpha-2", await visible());
  report("column counters follow the filter", (await browser.evaluate(`[...document.querySelectorAll("[data-count]")].reduce((sum, b) => sum + Number(b.textContent), 0)`)) === 2);
  await click('[data-board-filter=""]');

  await browser.evaluate(`(() => { const box = document.querySelector("[data-title-search]"); box.value = "excel  EXPORT"; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  report("title search matches every word, any order, any case", (await visible()) === "work-alpha-1", await visible());
  await browser.evaluate(`(() => { const box = document.querySelector("[data-title-search]"); box.value = "excel"; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  report("title search with one word finds both", (await visible()) === "work-alpha-1,work-beta-1", await visible());
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
  report("nothing is filtered before Apply", (await visible()) === "work-alpha-1,work-alpha-2,work-beta-1", await visible());
  await click("[data-range-apply]");
  report("created range keeps the ticket created inside it", (await visible()) === "work-alpha-2", await visible());
  report("the button shows the chosen range", (await browser.evaluate(`document.querySelector("[data-range-open]").textContent`)) === "Created: 4 Nov 2026 – 6 Nov 2026");

  // The date the range applies to is chosen in the dialog and takes effect with Apply.
  await click("[data-range-open]");
  await click('[data-date-field="updated"]');
  report("choosing the updated date changes nothing before Apply", (await visible()) === "work-alpha-2", await visible());
  await click("[data-range-apply]");
  report("the same range on the updated date hides a ticket updated later", (await visible()) === "", await visible());
  report("the button names the date it filters on", /^Updated: 4 Nov 2026/.test(await browser.evaluate(`document.querySelector("[data-range-open]").textContent`)));
  await click("[data-range-open]");
  await click('[data-date-field="created"]');
  await click("[data-range-apply]");

  // Keyboard: from the focused end day, ArrowRight then Enter starts a new range one day later.
  await click("[data-range-open]");
  const focusedBefore = await browser.evaluate(`document.activeElement.getAttribute("data-day")`);
  await key("ArrowRight");
  const focusedAfter = await browser.evaluate(`document.activeElement.getAttribute("data-day")`);
  report("the dialog opens with the range start focused, and ArrowRight moves one day", focusedBefore === "2026-11-04" && focusedAfter === "2026-11-05", `${focusedBefore} -> ${focusedAfter}`);
  await key("PageDown");
  report("PageDown moves one month and keeps the day in view", (await browser.evaluate(`document.activeElement.getAttribute("data-day")`)) === "2026-12-05");
  await click("[data-range-cancel]");
  report("Cancel leaves the applied range alone", (await visible()) === "work-alpha-2", await visible());

  // Presets, then Clear.
  await click("[data-range-open]");
  await click('[data-range-preset="last7"]');
  report("a preset fills both ends", await browser.evaluate(`document.querySelectorAll("[data-range-grid] .edge").length >= 1`));
  await click("[data-range-clear]");
  await click("[data-range-apply]");
  report("Clear then Apply removes the range", (await visible()) === "work-alpha-1,work-alpha-2,work-beta-1" && /Any date/.test(await browser.evaluate(`document.querySelector("[data-range-open]").textContent`)), await visible());

  // Filters are remembered across a reload.
  await click('[data-board-filter="work-beta"]');
  await openBoard(path.join(site, "index.html"));
  report("the chosen project survives a reload", (await visible()) === "work-beta-1", await visible());
  await click('[data-board-filter=""]');

  // Phone width, with the longest labels the row can get: a project chosen and a date range applied.
  await browser.evaluate(`localStorage.setItem("board-filters", JSON.stringify({ project: "work-alpha", field: "created", from: "2026-11-01", to: "2026-11-30", title: "" }))`);
  await browser.viewport(390, 800);
  await openBoard(path.join(site, "index.html"));
  await sleep(150);
  const layout = await browser.evaluate(`(() => { const board = document.querySelector(".board"); const cols = [...board.querySelectorAll("[data-column]")].map((c) => c.getBoundingClientRect()); return { sameRow: cols.length === 7 && cols.every((c) => Math.abs(c.top - cols[0].top) < 2), scrolls: board.scrollWidth > board.clientWidth + 50, pageWide: document.documentElement.scrollWidth <= innerWidth + 1, width: Math.round(cols[0].width) }; })()`);
  report("on a phone the columns sit side by side and the board scrolls sideways, the page does not", layout.sameRow && layout.scrolls && layout.pageWide, layout);
  const phone = await browser.evaluate(`(() => { const bar = document.querySelector(".filters"); const tops = [...bar.children].map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }); return { oneRow: Math.max(...tops) - Math.min(...tops) <= 4, scrolls: bar.scrollWidth > bar.clientWidth + 50, pageStill: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
  report("on a phone the filters stay in one row that scrolls sideways, the page does not", phone.oneRow && phone.scrolls && phone.pageStill, phone);
  await click("[data-project-open]");
  const panel = await browser.evaluate(`(() => { const el = document.querySelector("[data-project-panel]"); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { inside: r.left >= 0 && r.right <= innerWidth, uncovered: Boolean(top) && el.contains(top), tall: r.height > 100 }; })()`);
  report("on a phone the project list opens inside the screen and is not clipped by the scrolling row", panel.inside && panel.uncovered && panel.tall, panel);
  await key("Escape");
  const phoneFill = await browser.evaluate(`(() => { const board = document.querySelector(".board").getBoundingClientRect(); return { pageFits: document.documentElement.scrollHeight <= innerHeight + 1, gapBelow: Math.round(innerHeight - board.bottom) }; })()`);
  report("on a phone the page does not scroll either, and the board reaches the bottom", phoneFill.pageFits && phoneFill.gapBelow >= 0 && phoneFill.gapBelow <= 24, phoneFill);
  await shot("board-390");
  await key("Escape");

  // A crowded column shows ten cards and offers the rest in steps.
  await browser.viewport(1280, 900);
  await browser.evaluate(`localStorage.removeItem("board-filters")`);
  await openBoard(path.join(crowded, "index.html"));
  const shownCards = () => browser.evaluate(`[...document.querySelectorAll("a.ticket")].filter((a) => !a.hidden).length`);
  const text = (selector) => browser.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => !b.hidden); return el ? el.textContent : ""; })()`);
  report("a column of 23 shows 10 and counts all 23", (await shownCards()) === 10 && (await browser.evaluate(`[...document.querySelectorAll("[data-count]")].map((b) => b.textContent).join(",")`)).includes("23"), await shownCards());
  report("the button says how many more and how many are left", (await text("[data-more]")) === "Show 10 more (13 left)" && (await text("[data-less]")) === "", await text("[data-more]"));
  await click("[data-more]:not([hidden])");
  report("Show more adds ten", (await shownCards()) === 20 && (await text("[data-more]")) === "Show 3 more (3 left)" && (await text("[data-less]")) === "Show less", `${await shownCards()} ${await text("[data-more]")}`);
  await click("[data-more]:not([hidden])");
  report("the last step shows the rest and drops the button", (await shownCards()) === 23 && (await text("[data-more]")) === "");
  await typeInto("[data-title-search]", "number 2");
  // "2" is in 02, 12 and 20 to 23; with the newest first, 02 and 12 sit beyond the first ten.
  report("a search reaches cards beyond the first ten", (await shownCards()) === 6 && (await text("[data-more]")) === "", await shownCards());
  await typeInto("[data-title-search]", "");
  await click("[data-less]:not([hidden])");
  report("Show less returns to ten", (await shownCards()) === 10 && (await text("[data-less]")) === "");
  await shot("crowded-1280");

  // The board page itself never scrolls: the board fills what is left of the screen and only its cards move.
  const fill = await browser.evaluate(`(() => { const board = document.querySelector(".board").getBoundingClientRect(); return { pageFits: document.documentElement.scrollHeight <= innerHeight + 1, gapBelow: Math.round(innerHeight - board.bottom), boardScrolls: document.querySelector(".board").scrollHeight > document.querySelector(".board").clientHeight + 100, footer: document.querySelectorAll("footer.doc").length }; })()`);
  report("the page does not scroll; the board reaches the bottom of the screen and scrolls inside", fill.pageFits && fill.gapBelow >= 0 && fill.gapBelow <= 24 && fill.boardScrolls && fill.footer === 0, fill);

  // Scrolling down a long column keeps every column heading, with its counter, in view.
  await click("[data-more]:not([hidden])");
  const sticky = await browser.evaluate(`(() => { const board = document.querySelector(".board"); board.scrollTop = 700; const top = board.getBoundingClientRect().top; const heads = [...board.querySelectorAll("h3")].map((h) => Math.round(h.getBoundingClientRect().top - top)); const firstCard = board.querySelector("a.ticket:not([hidden])").getBoundingClientRect().top - top; return { scrolled: board.scrollTop > 300, heads, cardGone: firstCard < 0, opaque: getComputedStyle(board.querySelector("h3")).backgroundColor !== "rgba(0, 0, 0, 0)", counter: board.querySelectorAll("h3 [data-count]").length }; })()`);
  report("column headings and their counters stay at the top of the board while the cards scroll under them", sticky.scrolled && sticky.cardGone && sticky.opaque && sticky.counter === 7 && sticky.heads.slice(0, 4).every((y) => y === 0), sticky);
  await shot("crowded-scrolled-1280");
  await browser.evaluate(`document.querySelector(".board").scrollTop = 0`);
  await click("[data-less]:not([hidden])");

  await browser.colorScheme("dark");
  await openTicket(site, "work-alpha-2");
  report("ticket page shows created and updated dates", /Created\s*5 Nov 2026/.test(await browser.evaluate(`document.querySelector("header.doc").textContent`)) && /Updated\s*20 Nov 2026/.test(await browser.evaluate(`document.querySelector("header.doc").textContent`)));
  await click('[data-theme-set="light"]');
  report("the theme switch works from inside the header", (await browser.evaluate(`document.documentElement.getAttribute("data-theme")`)) === "light");
  await shot("ticket-1280");

  // An open page follows the data by itself: no server, no manual reload.
  // A flag set on the page disappears when the page reloads, which is how a reload is told apart from no reload.
  const mark = () => browser.evaluate(`window.__stillTheSamePage = true`);
  const samePage = () => browser.evaluate(`window.__stillTheSamePage === true`).catch(() => false);
  const until = async (probe, seconds) => { for (let i = 0; i < seconds * 4; i++) { if (await probe().catch(() => false)) return true; await sleep(250); } return false; };
  const column = (name) => browser.evaluate(`[...[...document.querySelectorAll("[data-column]")].find((c) => c.querySelector("h3").textContent.startsWith(${JSON.stringify(name)})).querySelectorAll("a.ticket")].map((a) => a.getAttribute("data-id")).sort().join(",")`);

  await browser.colorScheme("light");
  await openBoard(path.join(site, "index.html"));
  await click('[data-board-filter="work-alpha"]');
  await mark();
  tool(["set", "work-alpha-1", "--status", "doing"], "2026-11-22T09:00:00+07:00");
  const moved = await until(async () => !(await samePage()) && (await column("In progress")) === "1,2", 12);
  report("an open board shows a change by itself within a few seconds", moved, `same page: ${await samePage()}, in progress: ${await column("In progress").catch(() => "?")}`);
  report("the chosen project filter is still in place after it reloaded itself", (await visible()) === "work-alpha-1,work-alpha-2", await visible());

  await click("[data-range-open]");
  await mark();
  tool(["note", "work-alpha-1", "--text", "A note written while the date dialog was open on the board."], "2026-11-22T10:00:00+07:00");
  await sleep(7000);
  report("it does not reload under an open dialog", (await samePage()) && (await browser.evaluate(`document.querySelector("dialog[data-range]").open`)));
  await click("[data-range-cancel]");
  report("it catches up once the dialog is closed", await until(async () => !(await samePage()), 12));
  await drawn("Boolean(document.querySelector('.board'))");
  await click('[data-board-filter=""]');

  await openTicket(site, "work-alpha-2");
  await mark();
  tool(["note", "work-alpha-1", "--text", "A change to another ticket must not reload this page."], "2026-11-22T11:00:00+07:00");
  await sleep(7000);
  report("a ticket page ignores changes to other tickets", await samePage());
  tool(["note", "work-alpha-2", "--text", "This note should appear on the open ticket page by itself."], "2026-11-22T12:00:00+07:00");
  report("an open ticket page shows its own change by itself", await until(async () => (await browser.evaluate(`document.body.textContent.includes("should appear on the open ticket page by itself")`)), 12));

  // A long board keeps its place when it reloads itself.
  board = CROWDED_DB;
  await openBoard(path.join(crowded, "index.html"));
  await browser.evaluate(`document.querySelector(".board").scrollTop = 320`);
  await mark();
  tool(["note", "work-gamma-5", "--text", "A change on the crowded board, to see the scroll position survive."], "2026-11-22T13:00:00+07:00");
  const reloaded = await until(async () => !(await samePage()), 12);
  await drawn("Boolean(document.querySelector('.board'))");
  await sleep(300);
  const top = await browser.evaluate(`document.querySelector(".board").scrollTop`);
  report("after reloading itself the board is scrolled where it was", reloaded && Math.abs(top - 320) <= 4, `reloaded: ${reloaded}, scrollTop: ${top}`);
  board = DB;

  report("no script errors on any page", browser.pageErrors.length === 0, browser.pageErrors.slice(0, 3));
} finally {
  browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failure(s)` : "\nall checks passed");
process.exit(failed ? 1 : 0);
