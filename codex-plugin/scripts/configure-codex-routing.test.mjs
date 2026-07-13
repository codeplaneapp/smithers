import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  AppServer,
  FIELD_PATHS,
  HINT_TEXT,
  buildSnapshot,
  classifyState,
  currentFields,
  fieldsEqual,
  makeEdits,
  mergeSnapshot,
  parseArgs,
  parentIsScalar,
  restoreValues,
  restoreMatchesUser,
  recoverPendingState,
  resolveExecutable,
  isStaleLock,
  lockStatus,
  batchWrite,
  spawnSpec,
  withLock,
  installTransition,
  installFailureRecovery,
  disableTransition,
} from "./configure-codex-routing.mjs";

const config = (mode, usage) => ({ features: { multi_agent_v2: { multi_agent_mode_hint_text: mode, usage_hint_text: usage } } });

describe("Codex routing pure logic", () => {
  test("parses preview, apply, status, disable, and binary flags", () => {
    expect(parseArgs([]).action).toBe("preview");
    expect(parseArgs(["--apply", "--replace-existing-policy", "--codex-bin", "/tmp/codex"]).apply).toBe(true);
    expect(parseArgs(["--status", "--require-effective"]).requireEffective).toBe(true);
    expect(parseArgs(["--disable"]).action).toBe("disable");
    expect(() => parseArgs(["--status", "--disable"])).toThrow();
    expect(() => parseArgs(["--disable", "--replace-existing-policy"])).toThrow();
  });

  test("classifies absent, user conflict, installed, and drifted states", () => {
    const absent = config(undefined, undefined);
    const installedState = buildSnapshot(absent, "/tmp/codex/config.toml", "v1");
    installedState.managed = Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]));
    expect(classifyState({}, {}, null)).toBe("not installed");
    expect(classifyState(config("user", HINT_TEXT), {}, null)).toBe("user-conflict");
    expect(classifyState(config(HINT_TEXT, HINT_TEXT), config(HINT_TEXT, HINT_TEXT), installedState)).toBe("installed");
    expect(classifyState(config("changed", HINT_TEXT), config("changed", HINT_TEXT), installedState)).toBe("drifted");
    expect(classifyState({}, config("higher-layer", undefined), null)).toBe("effective-conflict");
    expect(classifyState(config("user", undefined), config("user", undefined), null)).toBe("user-conflict");
  });

  test("snapshots absent values and creates replace edits that delete them", () => {
    const state = buildSnapshot({}, "/tmp/codex/config.toml", "v1");
    expect(state.previous[FIELD_PATHS[0]]).toEqual({ present: false });
    expect(makeEdits(currentFields({})).every((edit) => edit.value === null)).toBe(true);
    expect(makeEdits({ [FIELD_PATHS[0]]: { present: false }, [FIELD_PATHS[1]]: "x" })[0].value).toBe(null);
  });

  test("preserves the original snapshot across re-runs and restores exact values", () => {
    const original = { features: { multi_agent_v2: { multi_agent_mode_hint_text: "a user's exact text" } } };
    const state = buildSnapshot(original, "/tmp/codex/config.toml", "v1");
    const rerun = mergeSnapshot(state, "/tmp/codex/config.toml");
    expect(rerun.previous[FIELD_PATHS[0]]).toEqual({ present: true, value: "a user's exact text" });
    expect(rerun.previous[FIELD_PATHS[1]]).toEqual({ present: false });
    const restored = restoreValues(rerun);
    expect(restored[FIELD_PATHS[0]]).toBe("a user's exact text");
    expect(restored[FIELD_PATHS[1]]).toEqual({ present: false });
    expect(fieldsEqual(undefined, undefined)).toBe(true);
    expect(restoreMatchesUser(original, restored)).toBe(true);
  });

  test("journals changed policy text as a from/to transition", () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const next = mergeSnapshot(old, "/tmp/codex/config.toml");
    expect(next.managed[FIELD_PATHS[0]]).toBe("old policy");
    expect(next.pending.from[FIELD_PATHS[0]]).toBe("old policy");
    expect(next.pending.to[FIELD_PATHS[0]]).toBe(HINT_TEXT);
    expect(recoverPendingState({ ...next, phase: "pending-install" }, currentFields(config("old policy", "old policy")))).toMatchObject({ action: "rollback", state: { managed: next.managed } });
    expect(recoverPendingState({ ...next, phase: "pending-install" }, currentFields(config(HINT_TEXT, HINT_TEXT)))).toMatchObject({ action: "commit", state: { managed: next.pending.to } });
  });

  test("pending initial install recovers by removing the journal when the snapshot remains", () => {
    const state = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), phase: "pending-install" };
    expect(recoverPendingState(state, currentFields({}))).toEqual({ state: null, action: "remove" });
  });

  test("pending upgrade requires both user and effective layers to validate", () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const pending = { ...mergeSnapshot(old, old.configPath), phase: "pending-install" };
    expect(() => recoverPendingState(pending, currentFields(config(HINT_TEXT, HINT_TEXT)), currentFields(config("higher layer", "higher layer")))).toThrow("pending recovery");
    expect(recoverPendingState(pending, currentFields(config("old policy", "old policy")), currentFields(config("old policy", "old policy"))).action).toBe("rollback");
  });

  test("pending disable recovery is read-only until a mutation command handles it", () => {
    const state = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), phase: "pending-disable" };
    expect(recoverPendingState(state, currentFields(config(undefined, undefined)))).toEqual({ state: null, action: "remove" });
    expect(recoverPendingState(state, currentFields(config(HINT_TEXT, HINT_TEXT)))).toMatchObject({ state, action: "none" });
  });

  test("reclaims dead and old locks but preserves a live fresh owner", () => {
    expect(isStaleLock({ pid: 12, createdAt: 1_000 }, 2_000, () => false)).toBe(true);
    expect(isStaleLock({ pid: 12, createdAt: 1_000 }, 2_000, () => true)).toBe(false);
    expect(isStaleLock({ pid: 12, createdAt: 1_000 }, 1_000 + 10 * 60 * 1000 + 1, () => true)).toBe(true);
  });

  test("status lock inspection does not mutate pending state", () => {
    const home = mkdtempSync(`${tmpdir()}/smithers-routing-lock-`);
    try {
      const lock = `${home}/.smithers-codex-routing.json.lock`;
      mkdirSync(lock);
      writeFileSync(`${lock}/owner`, JSON.stringify({ pid: 99, createdAt: Date.now() }));
      const before = readFileSync(`${lock}/owner`, "utf8");
      expect(lockStatus(home, Date.now(), () => true).locked).toBe(true);
      expect(readFileSync(`${lock}/owner`, "utf8")).toBe(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("reclaims a stale lock and never releases another owner's lock", () => {
    const home = mkdtempSync(`${tmpdir()}/smithers-routing-reclaim-`);
    try {
      const lock = `${home}/${".smithers-codex-routing.json"}.lock`;
      mkdirSync(lock);
      writeFileSync(`${lock}/owner`, JSON.stringify({ pid: 999999, createdAt: 1, nonce: "dead-owner" }));
      const release = withLock(home);
      const owner = JSON.parse(readFileSync(`${lock}/owner`, "utf8"));
      expect(owner.nonce).not.toBe("dead-owner");
      writeFileSync(`${lock}/owner`, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: "new-owner" }));
      release();
      expect(readFileSync(`${lock}/owner`, "utf8")).toContain("new-owner");
      rmSync(lock, { recursive: true, force: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("resolves Windows PATHEXT entries from PATH", () => {
    const seen = new Set(["C:\\bin\\codex.CMD"]);
    expect(resolveExecutable("codex", { platform: "win32", path: "C:\\bin", pathext: ".EXE;.CMD", exists: (path) => seen.has(path) })).toBe("C:\\bin\\codex.CMD");
  });

  test("launches Windows command wrappers through ComSpec", () => {
    expect(spawnSpec("C:\\Program Files\\Codex\\codex.CMD", ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program Files\\Codex\\codex.CMD" "--version"'],
    });
    expect(spawnSpec("/usr/local/bin/codex", ["--version"], "linux")).toEqual({ command: "/usr/local/bin/codex", args: ["--version"] });
  });

  test("aborts on an optimistic expectedVersion mismatch", async () => {
    const app = { request: async (method, params) => {
      expect(method).toBe("config/batchWrite");
      expect(params.expectedVersion).toBe("old-version");
      return { status: "error", message: "version mismatch" };
    } };
    await expect(batchWrite(app, [], "old-version")).rejects.toThrow("Unexpected config write status: error");
  });

  test("failed readback can roll back to the prior managed text", () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const pending = { ...mergeSnapshot(old, old.configPath), phase: "pending-install" };
    const afterRollback = recoverPendingState(pending, currentFields(config("old policy", "old policy")));
    expect(afterRollback.action).toBe("rollback");
    expect(afterRollback.state.managed[FIELD_PATHS[0]]).toBe("old policy");
  });

  test("pure install and disable transitions preserve the first snapshot", () => {
    const first = installTransition(null, currentFields({}), "/tmp/codex/config.toml", "v1");
    expect(first.createdState).toBe(true);
    expect(installFailureRecovery(first.nextState, true)).toMatchObject({ action: "remove", values: { [FIELD_PATHS[0]]: { present: false } } });
    const upgrade = installTransition({ ...first.nextState, managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) }, currentFields(config("old policy", "old policy")), "/tmp/codex/config.toml", "v2");
    expect(upgrade.nextState.pending.from[FIELD_PATHS[0]]).toBe("old policy");
    expect(installFailureRecovery(upgrade.nextState, false).state.managed[FIELD_PATHS[0]]).toBe("old policy");
    expect(disableTransition({ ...upgrade.nextState, managed: { ...upgrade.nextState.pending.from } }, currentFields(config("old policy", "old policy")))[FIELD_PATHS[0]]).toEqual({ present: false });
  });

  test("version mismatch leaves an upgrade journal recoverable at the prior policy", async () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const pending = { ...mergeSnapshot(old, old.configPath), phase: "pending-install" };
    const app = { request: async () => ({ status: "error", message: "version mismatch" }) };
    await expect(batchWrite(app, makeEdits(Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]))), "stale-version")).rejects.toThrow("Unexpected config write status");
    expect(recoverPendingState(pending, currentFields(config("old policy", "old policy")))).toMatchObject({ action: "rollback", state: { managed: old.managed } });
  });

  test("completed disable recovery is idempotent", () => {
    const state = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), phase: "pending-disable" };
    expect(recoverPendingState(state, currentFields({}))).toEqual({ state: null, action: "remove" });
    expect(recoverPendingState(state, currentFields({}))).toEqual({ state: null, action: "remove" });
  });

  test("detects conflicts, post-install edits, and scalar parents", () => {
    const state = buildSnapshot({}, "/tmp/codex/config.toml", "v1");
    expect(classifyState(config("someone else's policy", undefined), {}, null)).toBe("user-conflict");
    expect(classifyState(config("edited after setup", HINT_TEXT), config("edited after setup", HINT_TEXT), state)).toBe("drifted");
    expect(parentIsScalar({ features: { multi_agent_v2: true } })).toBe(true);
    expect(classifyState({ features: { multi_agent_v2: true } }, {}, null)).toContain("scalar");
  });

  test("constructs the exact batchWrite edits needed for replacement and deletion", () => {
    expect(makeEdits({ [FIELD_PATHS[0]]: "restored", [FIELD_PATHS[1]]: { present: false } })).toEqual([
      { keyPath: FIELD_PATHS[0], value: "restored", mergeStrategy: "replace" },
      { keyPath: FIELD_PATHS[1], value: null, mergeStrategy: "replace" },
    ]);
  });

  test("frames JSON-RPC responses by newline and resolves the matching request", async () => {
    const app = Object.create(AppServer.prototype);
    app.buffer = "";
    app.pending = new Map([[7, { method: "config/read", resolve: (value) => { app.value = value; }, reject: (error) => { throw error; } }]]);
    app.receive('{"id":7,"result":{"ok":true}}\n');
    expect(app.value).toEqual({ ok: true });
  });
});

const realTest = Bun.which("codex") ? test : test.skip;
realTest("real Codex CLI lifecycle uses an isolated temporary home", async () => {
  const binary = Bun.which("codex");
  const home = mkdtempSync(`${tmpdir()}/smithers-codex-routing-test-`);
  const script = new URL("./configure-codex-routing.mjs", import.meta.url).pathname;
  const run = (args) => Bun.spawnSync({ cmd: ["node", script, "--codex-bin", binary, ...args], env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const output = (result) => `${result.stdout.toString()}${result.stderr.toString()}`;
  const oldHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    expect(run([]).exitCode).toBe(0);
    expect(run(["--apply"]).exitCode).toBe(0);
    expect(run(["--status", "--require-effective"]).exitCode).toBe(0);
    expect(run(["--apply"]).exitCode).toBe(0); // re-apply preserves the original snapshot
    const app = new AppServer(binary);
    await app.initialize();
    let read = await app.request("config/read", { includeLayers: true, cwd: process.cwd() });
    const user = read.layers.find((layer) => layer.name?.type === "user");
    const changed = await app.request("config/batchWrite", { edits: [{ keyPath: FIELD_PATHS[0], value: "hand edited", mergeStrategy: "replace" }], expectedVersion: user.version, reloadUserConfig: true });
    expect(changed.status).toBe("ok");
    app.close();
    expect(run(["--disable", "--apply"]).exitCode).not.toBe(0);
    expect(run(["--status"]).exitCode).toBe(0);
    const repair = new AppServer(binary);
    await repair.initialize();
    read = await repair.request("config/read", { includeLayers: true, cwd: process.cwd() });
    const repairedUser = read.layers.find((layer) => layer.name?.type === "user");
    const repaired = await repair.request("config/batchWrite", { edits: makeEdits(Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]))), expectedVersion: repairedUser.version, reloadUserConfig: true });
    expect(repaired.status).toBe("ok");
    repair.close();
    expect(run(["--disable", "--apply"]).exitCode).toBe(0);
    expect(run(["--status", "--require-effective"]).exitCode).not.toBe(0);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
