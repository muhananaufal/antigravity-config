// Minimal headless-browser driver over the DevTools protocol, shared by doc-render and the browser test.
// No dependencies; needs Node 22+ for the global WebSocket. Works with Edge or Chrome.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CALL_TIMEOUT_MS = 30000;

/** Returns the browser executable path, or null when none is installed. DOC_BROWSER overrides detection. */
export function findBrowser() {
  const list = [process.env.DOC_BROWSER, ...CANDIDATES].filter(Boolean);
  return list.find((p) => fs.existsSync(p)) || null;
}

/** Starts a headless browser with a throwaway profile and returns a page-level session. */
export async function launch() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error("no browser found; set DOC_BROWSER to an Edge or Chrome executable");
  if (typeof WebSocket === "undefined") throw new Error("this script needs Node 22 or newer (global WebSocket)");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "doc-browser-"));
  const child = spawn(browserPath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const close = () => {
    try { child.kill(); } catch (e) { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* profile still locked; it lives in the temp dir */ }
  };

  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("browser did not report a DevTools endpoint within 20s")), 20000);
      child.stderr.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`browser exited early with code ${code}`)); });
    });
  } catch (error) { close(); throw error; }

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("could not connect to the browser")); });

  let nextId = 1;
  const pending = new Map();
  const pageErrors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      pageErrors.push((details.exception && details.exception.description) || details.text);
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
    }
  };
  let sessionId;
  const send = (method, params = {}) => {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    socket.send(JSON.stringify(payload));
    // A browser call that never answers must fail, not hang the whole run. Seen on 2026-11-10: one render
    // stopped mid-way for more than six minutes, and a requestAnimationFrame wait never resolved in a headless page.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer within ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await send("Page.enable");
  await send("Runtime.enable");

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error((details.exception && details.exception.description) || details.text);
    }
    return result.result.value;
  }

  return {
    browserPath,
    pageErrors,
    send,
    evaluate,
    /** Sets the viewport size in CSS pixels. */
    async viewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    /** Forces prefers-color-scheme to "light" or "dark". */
    async colorScheme(scheme) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    },
    /** Opens a local file and waits until the document and its fonts are ready. */
    async open(file) {
      await send("Page.navigate", { url: pathToFileURL(path.resolve(file)).href });
      for (let i = 0; i < 150; i++) {
        const ready = await evaluate("document.readyState === 'complete'").catch(() => false);
        if (ready) {
          await evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => true);
          return;
        }
        await sleep(100);
      }
      throw new Error("page did not finish loading within 15s");
    },
    /** Waits until every Mermaid diagram on the page has rendered or failed. Returns the list of final states. */
    async settleDiagrams() {
      for (let i = 0; i < 150; i++) {
        const states = await evaluate(`[...document.querySelectorAll("pre.mermaid")].map((p) => p.getAttribute("data-state"))`);
        if (!states.includes("pending") && !states.includes(null)) return states;
        await sleep(100);
      }
      return await evaluate(`[...document.querySelectorAll("pre.mermaid")].map((p) => p.getAttribute("data-state") || "pending")`);
    },
    /** Captures a PNG of the given page rectangle and writes it to disk. */
    async screenshot(file, clip) {
      const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
      fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    },
    close() {
      try { socket.close(); } catch (e) { /* already closed */ }
      close();
    },
  };
}
