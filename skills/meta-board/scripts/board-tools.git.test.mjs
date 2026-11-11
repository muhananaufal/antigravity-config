#!/usr/bin/env node
// Tests for the parts of board-tools that look at git: the ticket's branch, the commit behind "review",
// and the commit guard hook. Each run builds throwaway repositories and a throwaway board.
//
//   node board-tools.git.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "board-tools.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "board-git-test-"));
const DB = path.join(TMP, "board.db");
const ENV = { ...process.env, AETHERIS_BOARD: DB };
delete ENV.BOARD_SKIP;

function tool(args, { now = "2026-11-10T09:00:00+07:00" } = {}) {
  const out = spawnSync(process.execPath, ["--no-warnings", TOOL, ...args], { encoding: "utf8", cwd: TMP, env: { ...ENV, BOARD_NOW: now } });
  return { code: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

function git(cwd, args, { at = "2026-11-11T10:00:00+07:00", env = {} } = {}) {
  const out = spawnSync("git", args, { encoding: "utf8", cwd, env: { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, ...env } });
  return { code: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

function makeRepo(name) {
  const dir = path.join(TMP, "work", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.test"]);
  git(dir, ["config", "user.name", "Board Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "app.txt"), "one\n");
  git(dir, ["add", "."]);
  // Older than every ticket below, so it can never count as the work of a ticket.
  git(dir, ["commit", "-q", "-m", "chore: initial commit"], { at: "2026-11-01T10:00:00+07:00" });
  return dir;
}

function commit(dir, file, text, message, options) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ["add", "."], options);
  const made = git(dir, ["commit", "-q", "-m", message], options);
  return { ...made, hash: git(dir, ["rev-parse", "HEAD"]).text.trim() };
}

let counter = 0;
function file(data) {
  const name = path.join(TMP, `input-${++counter}.json`);
  fs.writeFileSync(name, JSON.stringify(data, null, 2));
  return name;
}

let failures = 0;
function expect(name, condition, detail) {
  if (condition) console.log(`ok    ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).trim().split("\n").slice(0, 8).join("\n      ")}` : ""}`); }
}

const ticket = (extra = {}) => ({
  title: "Claim limit per employee per month",
  summary: "Employees can claim transport for three duties a month. The fourth is refused with a message that explains the limit.",
  done_when: ["An employee with three claimed duties sees the limit message on the fourth."],
  sources: [{ claim: "Claims are stored per receipt photo", source: "app/Services/ReimburseService.php:88" }],
  approved_by: "user",
  user_words: "gass",
  branch: "feature/claim-limit",
  ...extra,
});
const idOf = (result) => (/#(\d+)/.exec(result.text) || [])[1];

const SHOP = makeRepo("shop");

// --- the ticket names its branch, and the type comes from it -------------------------------------
let id = null;
{
  const none = tool(["add", "--file", file(ticket({ branch: undefined })), "--dir", SHOP]);
  expect("add: in a git repository a ticket must name its branch", none.code === 1 && /"branch"/.test(none.text), none.text);
  const odd = tool(["add", "--file", file(ticket({ branch: "Feature/Claim Limit" })), "--dir", SHOP]);
  expect("add: a branch outside the naming rule is refused", odd.code === 1 && /feature\/, fix\//.test(odd.text), odd.text);
  const main = tool(["add", "--file", file(ticket({ branch: "main" })), "--dir", SHOP]);
  expect("add: main is not a work branch", main.code === 1 && /feature\/, fix\//.test(main.text), main.text);
  const clash = tool(["add", "--file", file(ticket({ type: "fix" })), "--dir", SHOP]);
  expect("add: a type that disagrees with the branch is refused", clash.code === 1 && /type/.test(clash.text) && /feature/.test(clash.text), clash.text);
  const ok = tool(["add", "--file", file(ticket()), "--dir", SHOP]);
  id = idOf(ok);
  const shown = tool(["show", id]);
  expect("add: branch stored and type derived from its prefix", ok.code === 0 && /^Branch: feature\/claim-limit$/m.test(shown.text) && /^Type: feature$/m.test(shown.text), ok.text + shown.text);
  const twin = tool(["add", "--file", file(ticket({ title: "Another ticket on the same branch" })), "--dir", SHOP]);
  expect("add: two open tickets cannot share a branch", twin.code === 1 && new RegExp(`#${id}`).test(twin.text) && /same branch/.test(twin.text), twin.text);
  const typed = tool(["list", "--type", "feature"]);
  const other = tool(["list", "--type", "fix"]);
  expect("list: filters by type", /^#\d+/m.test(typed.text) && !/^#\d+/m.test(other.text), typed.text + other.text);
}

// --- work starts on the ticket's branch ----------------------------------------------------------
{
  const onMain = tool(["set", id, "--status", "doing"]);
  expect("set doing: refused while the repository is on another branch", onMain.code === 1 && /feature\/claim-limit/.test(onMain.text) && /main/.test(onMain.text), onMain.text);
  git(SHOP, ["checkout", "-q", "-b", "feature/claim-limit"]);
  const onBranch = tool(["set", id, "--status", "doing"]);
  expect("set doing: accepted on the ticket's branch", onBranch.code === 0, onBranch.text);
}

// --- the commit guard ----------------------------------------------------------------------------
const hookFile = path.join(SHOP, ".git", "hooks", "pre-commit");
{
  const installed = tool(["hook", "install", "--dir", SHOP]);
  expect("hook install: writes the guard into the local hooks folder", installed.code === 0 && fs.existsSync(hookFile) && /board-tools commit guard/.test(fs.readFileSync(hookFile, "utf8")), installed.text);
  const again = tool(["hook", "install", "--dir", SHOP]);
  expect("hook install: installing again replaces its own guard", again.code === 0, again.text);

  const allowed = commit(SHOP, "app.txt", "two\n", "feat: add the claim limit");
  expect("guard: a commit on the branch of a ticket in progress goes through", allowed.code === 0, allowed.text);

  git(SHOP, ["checkout", "-q", "-b", "fix/untracked-work"]);
  const check = tool(["hook", "check", "--dir", SHOP]);
  expect("hook check: exit 1 on a branch without a ticket in progress", check.code === 1 && /fix\/untracked-work/.test(check.text) && /board-tools/.test(check.text), check.text);
  const blocked = commit(SHOP, "other.txt", "x\n", "fix: something nobody approved");
  expect("guard: a commit on a branch without a ticket is refused", blocked.code !== 0 && /no ticket in progress/.test(blocked.text), blocked.text);
  const skipped = git(SHOP, ["commit", "-q", "-m", "fix: the owner working alone"], { env: { BOARD_SKIP: "1" } });
  expect("guard: BOARD_SKIP lets the owner commit without a ticket", skipped.code === 0, skipped.text);

  git(SHOP, ["checkout", "-q", "main"]);
  const onMain = tool(["hook", "check", "--dir", SHOP]);
  expect("hook check: main is not guarded", onMain.code === 0, onMain.text);

  const broken = spawnSync(process.execPath, ["--no-warnings", TOOL, "hook", "check", "--dir", SHOP], { encoding: "utf8", env: { ...ENV, AETHERIS_BOARD: path.join(TMP, "work", "shop", "app.txt") } });
  git(SHOP, ["checkout", "-q", "fix/untracked-work"]);
  const brokenOnBranch = spawnSync(process.execPath, ["--no-warnings", TOOL, "hook", "check", "--dir", SHOP], { encoding: "utf8", env: { ...ENV, AETHERIS_BOARD: path.join(TMP, "work", "shop", "app.txt") } });
  expect("hook check: a board that cannot be read is exit 2, which the guard lets through", broken.status === 0 && brokenOnBranch.status === 2, `${broken.status} ${brokenOnBranch.status} ${brokenOnBranch.stderr}`);
  git(SHOP, ["checkout", "-q", "feature/claim-limit"]);
}

// --- review needs a real commit on the ticket's branch -------------------------------------------
{
  const head = git(SHOP, ["rev-parse", "HEAD"]).text.trim();
  const first = git(SHOP, ["rev-list", "--max-parents=0", "HEAD"]).text.trim();
  const stray = git(SHOP, ["rev-parse", "fix/untracked-work"]).text.trim();
  const EVIDENCE = "php artisan test: 412 passed, 0 failed";

  const none = tool(["set", id, "--status", "review", "--evidence", EVIDENCE]);
  expect("set review: refused without --commit", none.code === 1 && /--commit/.test(none.text), none.text);
  const fake = tool(["set", id, "--status", "review", "--evidence", EVIDENCE, "--commit", "0123456789abcdef0123456789abcdef01234567"]);
  expect("set review: a commit that does not exist is refused", fake.code === 1 && /not a commit/.test(fake.text), fake.text);
  const old = tool(["set", id, "--status", "review", "--evidence", EVIDENCE, "--commit", first]);
  expect("set review: a commit older than the ticket is refused", old.code === 1 && /before the ticket/.test(old.text), old.text);
  const elsewhere = tool(["set", id, "--status", "review", "--evidence", EVIDENCE, "--commit", stray]);
  expect("set review: a commit from another branch is refused", elsewhere.code === 1 && /not on feature\/claim-limit/.test(elsewhere.text), elsewhere.text);
  fs.writeFileSync(path.join(SHOP, "app.txt"), "three\n");
  const dirty = tool(["set", id, "--status", "review", "--evidence", EVIDENCE, "--commit", head]);
  expect("set review: uncommitted changes are refused", dirty.code === 1 && /uncommitted/.test(dirty.text) && /app\.txt/.test(dirty.text), dirty.text);
  git(SHOP, ["checkout", "-q", "--", "app.txt"]);
  const ok = tool(["set", id, "--status", "review", "--evidence", EVIDENCE, "--commit", head.slice(0, 8)]);
  const shown = tool(["show", id]);
  expect("set review: accepted with a real commit, stored in full", ok.code === 0 && shown.text.includes(head), ok.text + shown.text);
  const fixup = commit(SHOP, "app.txt", "four\n", "fix: a detail found while waiting for the check");
  expect("guard: commits stay possible while the ticket waits for the owner's check", fixup.code === 0, fixup.text);
  tool(["set", id, "--status", "done", "--words", "ok sudah"]);
  const after = commit(SHOP, "app.txt", "five\n", "feat: work after the ticket was closed");
  expect("guard: once the ticket is done its branch is closed for commits", after.code !== 0, after.text);
  const reuse = tool(["add", "--file", file(ticket({ title: "A second ticket reusing the branch name" })), "--dir", SHOP]);
  expect("add: a branch is free again once its ticket is closed", reuse.code === 0, reuse.text);
}

// --- accepted is not the same as merged: the merge is recorded once git shows it ------------------
{
  const early = tool(["merged", id, "--into", "main"]);
  expect("merged: refused while the ticket's commit is not on the target branch", early.code === 1 && /not on main/.test(early.text), early.text);
  const ghost = tool(["merged", id, "--into", "release/9.9.9"]);
  expect("merged: refused for a branch that does not exist", ghost.code === 1 && /no branch/.test(ghost.text), ghost.text);
  git(SHOP, ["reset", "-q", "--hard"]);
  git(SHOP, ["checkout", "-q", "main"]);
  const merge = git(SHOP, ["merge", "-q", "--no-edit", "feature/claim-limit"]);
  const done = tool(["merged", id, "--into", "main"], { now: "2026-11-18T09:00:00+07:00" });
  const shown = tool(["show", id]);
  expect("merged: recorded in the history once git has the commit on that branch", merge.code === 0 && done.code === 0 && /2026-11-18: merged into main/.test(shown.text) && /^Merged into: main$/m.test(shown.text), merge.text + done.text + shown.text);
  const again = tool(["merged", id, "--into", "main"]);
  expect("merged: the same branch is recorded once", again.code === 1 && /already/.test(again.text), again.text);
  const open = tool(["list", "--status", "ready", "--project", "shop"]);
  const openId = (/^#(\d+)/m.exec(open.text) || [])[1];
  const tooSoon = tool(["merged", openId, "--into", "main"]);
  expect("merged: only work that was handed over can be recorded as merged", tooSoon.code === 1 && /review or done/.test(tooSoon.text), tooSoon.text);

  const site = path.join(TMP, "site-merged");
  tool(["report", "--out", site]);
  const page = fs.readFileSync(path.join(site, `ticket-${id}.html`), "utf8");
  const board = fs.readFileSync(path.join(site, "index.html"), "utf8");
  expect("merged: the ticket page and the board card both say where the work was merged", /<b>Merged into<\/b> <code>main<\/code>/.test(page) && /Merged into main/.test(page) && /Merged into main<\/span>/.test(board));
  git(SHOP, ["checkout", "-q", "feature/claim-limit"]);
}

// --- hooks that are already there ----------------------------------------------------------------
{
  const dir = makeRepo("legacy");
  const hook = path.join(dir, ".git", "hooks", "pre-commit");
  const trace = path.join(dir, ".git", "old-hook-ran");
  fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${trace.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
  const original = fs.readFileSync(hook, "utf8");

  const ask = tool(["hook", "install", "--dir", dir]);
  expect("hook install: stops when another hook is there and names the three choices", ask.code === 1 && /chain/.test(ask.text) && /replace/.test(ask.text) && /skip/.test(ask.text) && fs.readFileSync(hook, "utf8") === original, ask.text);
  const skip = tool(["hook", "install", "--dir", dir, "--existing", "skip"]);
  expect("hook install --existing skip: leaves the project alone", skip.code === 0 && fs.readFileSync(hook, "utf8") === original, skip.text);

  const chain = tool(["hook", "install", "--dir", dir, "--existing", "chain"]);
  git(dir, ["checkout", "-q", "-b", "fix/no-ticket"]);
  const blocked = commit(dir, "a.txt", "a\n", "fix: no ticket");
  expect("hook install --existing chain: the old hook still runs, then the guard", chain.code === 0 && fs.existsSync(trace) && blocked.code !== 0 && /no ticket in progress/.test(blocked.text), chain.text + blocked.text);
  const removed = tool(["hook", "remove", "--dir", dir]);
  expect("hook remove: puts a chained hook back as it was", removed.code === 0 && fs.readFileSync(hook, "utf8") === original, removed.text);

  const replace = tool(["hook", "install", "--dir", dir, "--existing", "replace"]);
  const backups = fs.readdirSync(path.dirname(hook)).filter((name) => name.startsWith("pre-commit.backup-"));
  expect("hook install --existing replace: keeps a backup of what it replaced", replace.code === 0 && backups.length === 1 && fs.readFileSync(path.join(path.dirname(hook), backups[0]), "utf8") === original && /board-tools commit guard/.test(fs.readFileSync(hook, "utf8")), replace.text);
}

// --- hooks kept inside the working tree are shared with the team ----------------------------------
{
  const dir = makeRepo("shared-hooks");
  fs.mkdirSync(path.join(dir, ".husky"));
  git(dir, ["config", "core.hooksPath", ".husky"]);
  const ask = tool(["hook", "install", "--dir", dir]);
  const forced = tool(["hook", "install", "--dir", dir, "--existing", "replace"]);
  expect("hook install: refuses a hooks folder that lives in the working tree, whatever the option", ask.code === 1 && forced.code === 1 && /core\.hooksPath/.test(forced.text) && !fs.existsSync(path.join(dir, ".husky", "pre-commit")), ask.text + forced.text);
}

// --- the examples the skill points at are accepted by the tool as they stand ----------------------
{
  const ASSETS = path.join(HERE, "..", "assets");
  const dir = makeRepo("examples");
  const added = tool(["add", "--file", path.join(ASSETS, "ticket.example.json"), "--dir", dir]);
  const ticketId = idOf(added);
  const answered = tool(["decide", ticketId, "--answers", "K3", "--file", path.join(ASSETS, "decision.example.json")]);
  const idea = tool(["add", "--file", path.join(ASSETS, "idea.example.json"), "--dir", dir]);
  const approved = tool(["approve", idOf(idea), "--file", path.join(ASSETS, "approval.example.json")]);
  const shown = tool(["show", ticketId]);
  expect("examples: the full ticket, the answer to its open question, the idea and its approval are all accepted",
    added.code === 0 && answered.code === 0 && idea.code === 0 && approved.code === 0 && /^Type: feature$/m.test(shown.text) && /^Out of scope:/m.test(shown.text) && /^Not yet verified:/m.test(shown.text) && /^Links:/m.test(shown.text),
    added.text + answered.text + idea.text + approved.text);
}

// --- a folder without git ------------------------------------------------------------------------
{
  const plain = path.join(TMP, "notes");
  fs.mkdirSync(plain);
  const hook = tool(["hook", "install", "--dir", plain]);
  expect("hook install: a folder without git has nothing to guard", hook.code === 1 && /not a git repository/.test(hook.text), hook.text);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
