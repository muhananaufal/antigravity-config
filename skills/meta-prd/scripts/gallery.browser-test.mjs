#!/usr/bin/env node
// Opens a document in a real headless browser and clicks through every interactive piece of doc-script.
// Run it against the gallery after changing the style or script; it also accepts any document built on doc-style
// (components the document does not use are skipped and listed as such).
//
//   node gallery.browser-test.mjs [file.html]
//
// Exit 0 = all checks passed, 1 = a check failed, 3 = no browser found (nothing was tested; not a pass).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findBrowser, sleep } from "./lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GALLERY = path.join(HERE, "..", "assets", "component-gallery.html");
const target = path.resolve(process.argv[2] || GALLERY);
const isGallery = path.resolve(GALLERY) === target;

if (!fs.existsSync(target)) { console.log(`file not found: ${target}`); process.exit(1); }
if (!findBrowser()) {
  console.log("NO BROWSER: no Edge or Chrome found; set DOC_BROWSER. Nothing was tested.");
  process.exit(3);
}

let failed = 0;
let ran = 0;
const skipped = [];
function report(name, ok, detail) {
  ran++;
  if (!ok) failed++;
  console.log(`${ok ? "ok    " : "FAIL  "} ${name}${detail ? ` (${detail})` : ""}`);
}
// In the gallery every component must exist; in other documents a missing component is a skip.
function absent(name) {
  if (isGallery) report(name, false, "component missing from the gallery");
  else skipped.push(name);
}

const browser = await launch();
try {
  await browser.colorScheme("light");
  await browser.viewport(1280, 900);
  await browser.open(target);

  const toc = await browser.evaluate(`({ sections: document.querySelectorAll("main section[id]").length, links: document.querySelectorAll("nav.toc a").length, mobile: document.querySelectorAll(".toc-mobile a").length })`);
  report("table of contents built from sections", toc.sections > 0 && toc.links === toc.sections && toc.mobile === toc.sections, `sections ${toc.sections}, links ${toc.links}, mobile ${toc.mobile}`);

  const theme = await browser.evaluate(`(() => {
    const out = {};
    document.querySelector('[data-theme-set="dark"]').click();
    out.dark = document.documentElement.getAttribute("data-theme");
    out.darkPressed = document.querySelector('[data-theme-set="dark"]').getAttribute("aria-pressed");
    out.darkCanvas = getComputedStyle(document.body).backgroundColor;
    document.querySelector('[data-theme-set="light"]').click();
    out.light = document.documentElement.getAttribute("data-theme");
    out.lightCanvas = getComputedStyle(document.body).backgroundColor;
    document.querySelector('[data-theme-set="system"]').click();
    out.system = document.documentElement.getAttribute("data-theme");
    return out;
  })()`);
  report("theme buttons switch and reset the theme", theme.dark === "dark" && theme.darkPressed === "true" && theme.light === "light" && theme.system === null && theme.darkCanvas !== theme.lightCanvas, `dark ${theme.darkCanvas}, light ${theme.lightCanvas}`);

  await browser.open(target + "");
  await browser.send("Page.navigate", { url: (await browser.evaluate("location.href.split('?')[0]")) + "?theme=dark" });
  await sleep(600);
  const forced = await browser.evaluate(`({ attr: document.documentElement.getAttribute("data-theme"), stored: (() => { try { return Object.keys(localStorage).filter((k) => k.endsWith(":theme")).map((k) => localStorage.getItem(k)); } catch (e) { return ["storage error"]; } })() })`);
  report("?theme=dark forces the theme without storing it", forced.attr === "dark" && !forced.stored.includes("dark"), JSON.stringify(forced));
  await browser.open(target);

  const tabs = await browser.evaluate(`(() => {
    const box = document.querySelector(".tabs");
    if (!box) return null;
    const buttons = box.querySelectorAll("[data-tab]");
    buttons[1].click();
    const panels = [...box.querySelectorAll("[data-panel]")].map((p) => p.hidden);
    const selected = [...buttons].map((b) => b.getAttribute("aria-selected"));
    buttons[0].click();
    const back = [...box.querySelectorAll("[data-panel]")].map((p) => p.hidden);
    return { panels, selected, back };
  })()`);
  if (tabs) report("tabs show one panel at a time", tabs.panels[0] === true && tabs.panels[1] === false && tabs.selected[1] === "true" && tabs.back[0] === false && tabs.back[1] === true, JSON.stringify(tabs.panels));
  else absent("tabs");

  const filter = await browser.evaluate(`(() => {
    const group = document.querySelector("[data-filter-target]");
    if (!group) return null;
    const table = document.querySelector(group.getAttribute("data-filter-target"));
    const rows = () => [...table.querySelectorAll("[data-tags]")];
    const total = rows().length;
    const button = [...group.querySelectorAll("[data-filter]")].find((b) => b.getAttribute("data-filter"));
    const tag = button.getAttribute("data-filter");
    button.click();
    const expected = rows().filter((r) => r.getAttribute("data-tags").split(/\\s+/).includes(tag)).length;
    const shown = rows().filter((r) => !r.hidden).length;
    group.querySelector('[data-filter=""]').click();
    const reset = rows().filter((r) => !r.hidden).length;
    return { total, tag, expected, shown, reset };
  })()`);
  if (filter) report("row filter hides non-matching rows and resets", filter.shown === filter.expected && filter.shown < filter.total && filter.reset === filter.total, `tag ${filter.tag}: ${filter.shown} of ${filter.total}`);
  else absent("row filter");

  const checkBefore = await browser.evaluate(`(() => {
    const box = document.querySelector(".checklist[data-store] input[data-key]");
    if (!box) return null;
    if (box.checked) box.click();
    box.click();
    return { checked: box.checked, key: box.getAttribute("data-key") };
  })()`);
  if (checkBefore) {
    await browser.open(target);
    const checkAfter = await browser.evaluate(`(() => {
      const box = document.querySelector(".checklist[data-store] input[data-key]");
      const result = box.checked;
      if (box.checked) box.click();
      return result;
    })()`);
    report("checklist state survives a reload", checkBefore.checked === true && checkAfter === true, `key ${checkBefore.key}`);
  } else absent("checklist");

  const copy = await browser.evaluate(`({ blocks: document.querySelectorAll("pre[data-copy]").length, buttons: document.querySelectorAll("pre[data-copy] > button.copy").length })`);
  if (copy.blocks) report("copy buttons added to code blocks", copy.buttons === copy.blocks, `${copy.buttons} of ${copy.blocks}`);
  else absent("copy button");

  const scrollbar = await browser.evaluate(`({ width: getComputedStyle(document.documentElement, "::-webkit-scrollbar").width, radius: getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb").borderTopLeftRadius })`);
  report("custom scrollbar rules apply", scrollbar.width === "12px" && scrollbar.radius !== "0px", `width ${scrollbar.width}, thumb radius ${scrollbar.radius}`);

  const diagramStates = await browser.settleDiagrams();
  if (diagramStates.length) {
    const svg = await browser.evaluate(`document.querySelectorAll("pre.mermaid svg").length`);
    if (diagramStates.every((s) => s === "ready")) report("diagrams rendered", svg === diagramStates.length, `${svg} of ${diagramStates.length}`);
    else if (diagramStates.includes("pending")) report("diagrams reached a final state", false, diagramStates.join(","));
    else {
      const readable = await browser.evaluate(`[...document.querySelectorAll('pre.mermaid[data-state="failed"]')].every((p) => p.textContent.trim().length > 0)`);
      report("diagram source stays readable when the library cannot load", readable === true, "offline or blocked; rendering itself was NOT tested");
    }
  } else absent("diagram");

  const spy = await browser.evaluate(`(async () => {
    const sections = [...document.querySelectorAll("main section[id]")];
    const pick = sections[Math.min(4, sections.length - 1)];
    pick.scrollIntoView({ behavior: "instant", block: "start" });
    await new Promise((r) => setTimeout(r, 600));
    const current = document.querySelector('nav.toc a[aria-current="true"]');
    return { want: "#" + pick.id, got: current ? current.getAttribute("href") : null };
  })()`);
  report("current section highlighted while scrolling", spy.got === spy.want, `want ${spy.want}, got ${spy.got}`);

  const wide = await browser.evaluate(`({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })`);
  report("no horizontal overflow at 1280px", wide.scroll <= wide.inner, `scrollWidth ${wide.scroll}, viewport ${wide.inner}`);

  await browser.viewport(390, 800);
  await sleep(300);
  const narrow = await browser.evaluate(`({
    scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
    side: getComputedStyle(document.querySelector("nav.toc")).display,
    mobile: document.querySelector(".toc-mobile") ? getComputedStyle(document.querySelector(".toc-mobile")).display : "missing"
  })`);
  report("no horizontal overflow at 390px", narrow.scroll <= narrow.inner, `scrollWidth ${narrow.scroll}, viewport ${narrow.inner}`);
  report("table of contents moves to the top on narrow screens", narrow.side === "none" && narrow.mobile === "block", `side ${narrow.side}, mobile ${narrow.mobile}`);

  // A source label inside a pro or con must stay inside the text column, not drop into the marker column.
  await browser.viewport(1280, 900);
  await sleep(200);
  const optionLabel = await browser.evaluate(`(() => {
    const label = document.querySelector(".pros li .lbl, .cons li .lbl");
    if (!label) return null;
    const item = label.closest("li").getBoundingClientRect();
    const box = label.getBoundingClientRect();
    return { indent: Math.round(box.left - item.left), sameRow: Math.round(box.top - item.top) < 8 };
  })()`);
  if (optionLabel) report("label inside a pro or con stays in the text column", optionLabel.indent >= 18 && optionLabel.sameRow, `indent ${optionLabel.indent}px, same row ${optionLabel.sameRow}`);
  else absent("label inside a pro or con");

  // In the dark theme an edge label must sit on the card colour, not on a black box.
  await browser.colorScheme("dark");
  await browser.open(target);
  const darkStates = await browser.settleDiagrams();
  if (darkStates.length && darkStates.every((s) => s === "ready")) {
    const edge = await browser.evaluate(`(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--surface)";
      document.body.appendChild(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const seen = [...document.querySelectorAll("pre.mermaid .edgeLabel, pre.mermaid .edgeLabel *")]
        .map((node) => getComputedStyle(node).backgroundColor)
        .concat([...document.querySelectorAll("pre.mermaid .edgeLabel rect, pre.mermaid rect.background")].map((node) => getComputedStyle(node).fill))
        .filter((color) => color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent" && color !== "none");
      return { surface, seen: [...new Set(seen)] };
    })()`);
    // Mermaid also paints a half-transparent copy of the same colour; over the card that is still the card colour,
    // so only the red, green and blue values are compared.
    const rgb = (color) => (color.match(/\d+/g) || []).slice(0, 3).join(",");
    if (edge.seen.length) report("diagram edge labels use the card colour in the dark theme", edge.seen.every((color) => rgb(color) === rgb(edge.surface)), `card ${edge.surface}, labels ${edge.seen.join(" | ")}`);
    else absent("diagram edge label");
  } else if (darkStates.length) skipped.push("diagram edge label colour (library not loaded)");
  else absent("diagram edge label");
  await browser.colorScheme("light");

  report("no script errors", browser.pageErrors.length === 0, browser.pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  failed++;
  console.log(`FAIL   test run aborted: ${error.message}`);
} finally {
  browser.close();
}

if (skipped.length) console.log(`skipped (component not used in this document): ${skipped.join(", ")}`);
console.log(`${path.basename(target)}: ${ran} checks, ${failed} failed, ${skipped.length} skipped`);
process.exit(failed ? 1 : 0);
