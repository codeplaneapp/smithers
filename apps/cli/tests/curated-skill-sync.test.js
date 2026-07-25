import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  curatedSkillStatus,
  formatCuratedSkillList,
  formatSkillsAddSummary,
  syncCuratedSkill,
} from "../src/curatedSkillSync.js";
import { parseSkillsSubcommandArgv } from "../src/agent-wiring/parseAgentWiringArgv.js";
import { syncSkillsAfterUpgrade } from "../src/syncSkillsAfterUpgrade.js";

const CURRENT_SKILL = "---\nname: smithers\n---\n# Smithers v2\n";
const CURRENT_BUNDLE = "LLMS-FULL BUNDLE v2\n";
const STALE_SKILL = "---\nname: smithers\n---\n# Smithers v1\n";

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Bundled skill source (what the installed package ships) plus a temp HOME. */
function fixture() {
  const sourceDir = tempDir("smithers-curated-src-");
  writeFileSync(join(sourceDir, "SKILL.md"), CURRENT_SKILL);
  writeFileSync(join(sourceDir, "llms-full.txt"), CURRENT_BUNDLE);
  const homeDir = tempDir("smithers-curated-home-");
  mkdirSync(join(homeDir, ".claude", "skills"), { recursive: true });
  return {
    sourceDir,
    homeDir,
    claudeSkill: join(homeDir, ".claude", "skills", "smithers"),
    opts: { homeDir, sourceDir, env: {}, detections: [], version: "0.31.0" },
  };
}

function writeStale(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), STALE_SKILL);
  writeFileSync(join(dir, "llms-full.txt"), "old bundle\n");
}

test("skills add syncs the curated skill with no TTY, in CI, and non-interactively", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  // The pre-fix path only refreshed behind `process.stderr.isTTY`, so an agent
  // or CI session was left on the previous release's skill (#1377).
  const isTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  onTestFinished(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
  });

  const { status, optedOut } = syncCuratedSkill({ ...f.opts, env: { CI: "1" } });

  expect(optedOut).toBe(false);
  expect(readFileSync(join(f.claudeSkill, "SKILL.md"), "utf8")).toBe(CURRENT_SKILL);
  expect(readFileSync(join(f.claudeSkill, "llms-full.txt"), "utf8")).toBe(CURRENT_BUNDLE);
  expect(status.stale).toBe(false);
  expect(status.installs.find((i) => i.id === "claude")?.state).toBe("current");
});

test("a second sync is a no-op that still reports the curated skill as current", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  syncCuratedSkill(f.opts);
  const { status } = syncCuratedSkill(f.opts);
  expect(status.stale).toBe(false);
  expect(status.installs.find((i) => i.id === "claude")).toMatchObject({
    state: "current",
    version: "0.31.0",
  });
});

test("SMITHERS_NO_SKILL_REFRESH=1 is still honored by an explicit sync", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const { optedOut } = syncCuratedSkill({ ...f.opts, env: { SMITHERS_NO_SKILL_REFRESH: "1" } });
  expect(optedOut).toBe(true);
  expect(readFileSync(join(f.claudeSkill, "SKILL.md"), "utf8")).toBe(STALE_SKILL);
});

test("curatedSkillStatus flags a stale copy against the installed package", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const status = curatedSkillStatus(f.opts);
  const claude = status.installs.find((i) => i.id === "claude");
  expect(claude?.state).toBe("stale");
  // No marker wrote this copy, so no release can be named for it.
  expect(claude?.version).toBeNull();
  expect(status.stale).toBe(true);
});

test("curatedSkillStatus flags a stale llms-full bundle when SKILL.md is current", () => {
  const f = fixture();
  mkdirSync(f.claudeSkill, { recursive: true });
  writeFileSync(join(f.claudeSkill, "SKILL.md"), CURRENT_SKILL);
  writeFileSync(join(f.claudeSkill, "llms-full.txt"), "old bundle\n");

  const status = curatedSkillStatus(f.opts);

  expect(status.installs.find((i) => i.id === "claude")?.state).toBe("stale");
  expect(status.stale).toBe(true);
});

test("curatedSkillStatus reports a detected agent that has no curated skill yet", () => {
  const f = fixture();
  const status = curatedSkillStatus(f.opts);
  expect(status.installs.find((i) => i.id === "claude")?.state).toBe("missing");
  expect(status.stale).toBe(true);
});

test("skills list output names the curated skill, its version, and how to fix it", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const listing = formatCuratedSkillList(curatedSkillStatus(f.opts));
  expect(listing).toContain("Curated skill (smithers, bundled v0.31.0)");
  expect(listing).toContain("Claude Code");
  expect(listing).toContain("stale");
  expect(listing).toContain("smithers skills add");

  syncCuratedSkill(f.opts);
  const fresh = formatCuratedSkillList(curatedSkillStatus(f.opts));
  expect(fresh).toContain("current (v0.31.0)");
  expect(fresh).not.toContain("skills add");
});

test("skills add success output states BOTH skill sets, so it cannot mask a stale curated skill", () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const stale = formatSkillsAddSummary({ status: curatedSkillStatus(f.opts), commandSkillCount: 71 });
  expect(stale).toContain("71 command skills");
  expect(stale).toContain("still not current");

  syncCuratedSkill(f.opts);
  const synced = formatSkillsAddSummary({ status: curatedSkillStatus(f.opts), commandSkillCount: 71 });
  expect(synced).toBe("✓ Synced 71 command skills + the curated `smithers` skill v0.31.0 (Claude Code).");
});

test("parseSkillsSubcommandArgv recognizes add and list, and ignores help/other commands", () => {
  expect(parseSkillsSubcommandArgv(["skills", "add"])).toBe("add");
  expect(parseSkillsSubcommandArgv(["skills", "add", "--no-global"])).toBe("add");
  expect(parseSkillsSubcommandArgv(["skills", "add", "--depth", "2"])).toBe("add");
  expect(parseSkillsSubcommandArgv(["skills", "list"])).toBe("list");
  expect(parseSkillsSubcommandArgv(["--format", "json", "skills", "add"])).toBe("add");
  expect(parseSkillsSubcommandArgv(["skills"])).toBeNull();
  expect(parseSkillsSubcommandArgv(["skills", "add", "--help"])).toBeNull();
  expect(parseSkillsSubcommandArgv(["mcp", "add"])).toBeNull();
  expect(parseSkillsSubcommandArgv(["workflow", "skills"])).toBeNull();
});

test("update re-runs the upgraded CLI's `skills add` so both skill sets regenerate", async () => {
  const calls = [];
  const spawn = (execPath, args) => {
    calls.push([execPath, ...args]);
    return {
      on(event, handler) {
        if (event === "close") queueMicrotask(() => handler(0));
      },
    };
  };
  const result = await syncSkillsAfterUpgrade({
    commandSkillsInstalled: true,
    env: {},
    execPath: "/bin/node",
    entry: "/usr/local/lib/smithers/index.js",
    spawn,
  });
  expect(calls).toEqual([["/bin/node", "/usr/local/lib/smithers/index.js", "skills", "add"]]);
  expect(result).toMatchObject({ via: "cli", ok: true });
});

test("a failed post-upgrade re-exec still syncs the curated skill in-process", async () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const spawn = () => ({
    on(event, handler) {
      if (event === "close") queueMicrotask(() => handler(1));
    },
  });
  const result = await syncSkillsAfterUpgrade({
    commandSkillsInstalled: true,
    env: {},
    entry: "/usr/local/lib/smithers/index.js",
    spawn,
    sync: (opts) => syncCuratedSkill({ ...f.opts, ...opts, env: {} }),
  });
  expect(result.via).toBe("in-process");
  expect(result.error).toContain("exited with code 1");
  expect(readFileSync(join(f.claudeSkill, "SKILL.md"), "utf8")).toBe(CURRENT_SKILL);
});

test("update syncs the curated skill even when no command skills were installed", async () => {
  const f = fixture();
  writeStale(f.claudeSkill);
  const result = await syncSkillsAfterUpgrade({
    commandSkillsInstalled: false,
    env: {},
    sync: (opts) => syncCuratedSkill({ ...f.opts, ...opts, env: {} }),
  });
  expect(result).toMatchObject({ via: "in-process", ok: true });
  expect(readFileSync(join(f.claudeSkill, "SKILL.md"), "utf8")).toBe(CURRENT_SKILL);
});

test("the update handler syncs skills AFTER the upgrade child exits successfully", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const upgraded = source.indexOf("✓ Upgraded to ${latest}.");
  const sync = source.indexOf("syncSkillsAfterUpgrade({");
  const failed = source.indexOf("Upgrade command exited with code");
  expect(upgraded).toBeGreaterThan(-1);
  expect(sync).toBeGreaterThan(upgraded);
  // The early return on a failed upgrade must precede the sync: an upgrade that
  // did not finish must not claim the skills are current.
  expect(failed).toBeLessThan(sync);
});
