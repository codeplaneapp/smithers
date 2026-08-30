import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  batchWrite,
  spawnSpec,
  withLock,
  installTransition,
  installFailureRecovery,
  disableTransition,
  executeInstallTransition,
  readConfig,
  readStatus,
  statusSnapshot,
  journalOwnership,
  tomlBasicString,
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

  test("attributes each effective managed field to its winning layer", async () => {
    const data = await readConfig({ request: async () => ({
      config: config("project policy", "project usage"),
      layers: [
        { name: { type: "user" }, version: "v1", config: config(HINT_TEXT, HINT_TEXT) },
        { name: { type: "project" }, config: config("project policy", "project usage") },
      ],
    }) });
    expect(data.effectiveLayerByField[FIELD_PATHS[0]]).toEqual({ type: "project" });
    expect(data.effectiveLayerByField[FIELD_PATHS[1]]).toEqual({ type: "project" });
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

  test("pending upgrade is owned by the user layer and reports effective overrides", () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const pending = { ...mergeSnapshot(old, old.configPath), phase: "pending-install" };
    expect(recoverPendingState(pending, currentFields(config(HINT_TEXT, HINT_TEXT)), currentFields(config("higher layer", "higher layer")))).toMatchObject({ action: "commit", effectiveOverride: true });
    expect(recoverPendingState(pending, currentFields(config("old policy", "old policy")), currentFields(config("higher layer", "higher layer")))).toMatchObject({ action: "rollback", effectiveOverride: true });
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

  test("concurrent status reads a live pending journal without mutating it", async () => {
    const home = mkdtempSync(`${tmpdir()}/smithers-routing-lock-`);
    try {
      const lock = `${home}/.smithers-codex-routing.json.lock`;
      const pending = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), phase: "pending-install" };
      writeFileSync(`${home}/.smithers-codex-routing.json`, `${JSON.stringify(pending, null, 2)}\n`);
      const before = readFileSync(`${home}/.smithers-codex-routing.json`, "utf8");
      mkdirSync(lock);
      writeFileSync(`${lock}/owner`, JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: "live-owner" }));
      let readStarted;
      let reads = 0;
      const started = new Promise((resolve) => { readStarted = resolve; });
      const statusPromise = readStatus(home, async () => {
        reads += 1;
        readStarted();
        if (reads === 1) writeFileSync(`${home}/.smithers-codex-routing.json`, `${JSON.stringify({ ...pending, marker: "interleaved" }, null, 2)}\n`);
        else if (reads === 2) writeFileSync(`${home}/.smithers-codex-routing.json`, before);
        await Promise.resolve();
        return { user: {}, effective: {}, effectiveLayerByField: {} };
      });
      await started;
      const interleaved = statusSnapshot(home);
      const status = await statusPromise;
      expect(status.lock.locked).toBe(true);
      expect(status.lock.stale).toBe(false);
      expect(status.state).toEqual(pending);
      expect(classifyState(status.user, status.effective, status.state)).toBe("drifted");
      expect(reads).toBeGreaterThan(1);
      expect(interleaved.journalBefore).toContain('"marker": "interleaved"');
      expect(status.journalAfter).toBe(before);
      expect(readFileSync(`${home}/.smithers-codex-routing.json`, "utf8")).toBe(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("byte-identical journal rewrites (ABA) are detected as instability", async () => {
    const home = mkdtempSync(`${tmpdir()}/smithers-routing-aba-`);
    try {
      const journal = `${home}/.smithers-codex-routing.json`;
      writeFileSync(journal, `${JSON.stringify(buildSnapshot({}, "/tmp/codex/config.toml", "v1"), null, 2)}\n`);
      const bytes = readFileSync(journal, "utf8");
      await expect(readStatus(home, async () => {
        // Rewrite identical bytes through the production temp+rename path:
        // the content matches but the inode does not, so the revision guard
        // must treat every attempt as unstable.
        const temporary = `${journal}.aba.tmp`;
        writeFileSync(temporary, bytes);
        renameSync(temporary, journal);
        return { user: {}, effective: {}, effectiveLayerByField: {} };
      })).rejects.toThrow("Routing journal changed while reading status");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("journal ownership follows the journal's recorded config path", () => {
    const state = buildSnapshot({}, "/tmp/codex-a/config.toml", "v1");
    expect(journalOwnership(state, "/tmp/codex-a/config.toml")).toEqual({ owned: true });
    expect(journalOwnership(state, "/tmp/codex-a/../codex-a/config.toml")).toEqual({ owned: true });
    expect(journalOwnership(null, "/tmp/codex-a/config.toml")).toEqual({ owned: true });
    expect(journalOwnership(state, "/tmp/codex-b/config.toml")).toEqual({ owned: false, journalConfigPath: "/tmp/codex-a/config.toml" });
  });

  test("a foreign journal is ignored for status classification", () => {
    const state = buildSnapshot({}, "/tmp/codex-a/config.toml", "v1");
    const ownership = journalOwnership(state, "/tmp/codex-b/config.toml");
    expect(ownership.owned).toBe(false);
    // Status must classify against a null state (journal not trusted), so an
    // empty config on the other CODEX_HOME reads as "not installed", not "installed".
    expect(classifyState({}, {}, ownership.owned ? state : null)).toBe("not installed");
  });

  test("tomlBasicString escapes Windows path separators for TOML keys", () => {
    expect(tomlBasicString("C:\\Users\\dev\\project")).toBe('"C:\\\\Users\\\\dev\\\\project"');
    expect(tomlBasicString('/tmp/with "quotes"')).toBe('"/tmp/with \\"quotes\\""');
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

  test("failed readback runs the production rollback transition and persists prior state", async () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const pending = { ...mergeSnapshot(old, old.configPath), phase: "pending-install" };
    let persisted = pending;
    let userConfig = config("old policy", "old policy");
    const writes = [];
    const writeBatch = async (edits, expectedVersion, options) => {
      writes.push({ edits, expectedVersion, options });
      userConfig = config(edits[0].value, edits[1].value);
      if (writes.length === 1) return { status: "ok", version: "after-write" };
      expect(options).toEqual({ allowOverridden: true });
      return { status: "okOverridden", version: "rolled-back" };
    };
    await expect(executeInstallTransition({
      nextState: pending,
      target: pending.pending.to,
      createdState: false,
      version: "before-write",
      writePending: (state) => { persisted = JSON.parse(JSON.stringify(state)); },
      writeCommitted: (state) => { persisted = JSON.parse(JSON.stringify(state)); },
      removePending: () => { persisted = null; },
      writeBatch,
      read: async () => ({ user: userConfig, effective: writes.length === 1 ? config("higher layer", "higher layer") : userConfig }),
      classify: classifyState,
    })).rejects.toThrow("Effective installation validation failed");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual({ edits: makeEdits(pending.pending.to), expectedVersion: "before-write", options: undefined });
    expect(writes[1]).toEqual({ edits: makeEdits(pending.pending.from), expectedVersion: "after-write", options: { allowOverridden: true } });
    expect(userConfig).toEqual(config("old policy", "old policy"));
    expect(persisted).toEqual(JSON.parse(JSON.stringify({ ...pending, phase: "committed", managed: { ...pending.pending.from }, pending: undefined })));
    expect(recoverPendingState(persisted, currentFields(userConfig), currentFields(userConfig)).action).toBe("none");
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

  test("version mismatch leaves exactly the production journal written before the failed write", async () => {
    const old = { ...buildSnapshot({}, "/tmp/codex/config.toml", "v1"), managed: Object.fromEntries(FIELD_PATHS.map((path) => [path, "old policy"])) };
    const transition = installTransition(old, currentFields(config("old policy", "old policy")), old.configPath, "new-version");
    let persisted;
    const events = [];
    await expect(executeInstallTransition({
      ...transition,
      version: "stale-version",
      writePending: (state) => { events.push("journal"); persisted = JSON.parse(JSON.stringify(state)); },
      writeCommitted: (state) => { persisted = JSON.parse(JSON.stringify(state)); },
      removePending: () => { persisted = null; },
      writeBatch: async (edits, expectedVersion, options) => {
        events.push(["write", persisted, edits, expectedVersion, options]);
        expect(edits).toEqual(makeEdits(transition.target));
        expect(expectedVersion).toBe("stale-version");
        expect(options).toBeUndefined();
        const error = new Error("Unexpected config write status: error");
        error.writeResult = { status: "error", version: undefined };
        throw error;
      },
      read: async () => ({ user: config("old policy", "old policy"), effective: config("old policy", "old policy") }),
      classify: classifyState,
    })).rejects.toThrow("Unexpected config write status");
    expect(events).toHaveLength(2);
    expect(events[0]).toBe("journal");
    expect(events[1][0]).toBe("write");
    expect(events[1][1]).toEqual({ ...transition.nextState, phase: "pending-install" });
    expect(persisted).toEqual(JSON.parse(JSON.stringify({ ...transition.nextState, phase: "pending-install" })));
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
    const status = run(["--status", "--require-effective"]);
    expect(status.exitCode).toBe(0);
    const statusText = output(status);
    for (const path of FIELD_PATHS) expect(statusText).toContain(`${path}:`);
    expect(statusText).toContain("(layer: user)");
    const preview = run([]);
    expect(preview.exitCode).toBe(0); // dry-run preserves the original snapshot
    const previewText = output(preview);
    for (const path of FIELD_PATHS) expect(previewText).toContain(`${path}:`);
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
  // Real `codex` starts, several per case, each costing seconds. 30 s was a
  // budget this suite fit into only on an idle machine and timed out on a
  // loaded one. The budget bounds a hang, not the work, so it is generous.
}, 180_000);

realTest("real Codex status and dry-run attribute each effective field to its winning layer", async () => {
  const binary = Bun.which("codex");
  const home = mkdtempSync(`${tmpdir()}/smithers-codex-routing-layer-test-`);
  const project = mkdtempSync(`${tmpdir()}/smithers-codex-routing-project-`);
  mkdirSync(`${project}/.codex`);
  writeFileSync(`${project}/.codex/config.toml`, "[features.multi_agent_v2]\n");
  writeFileSync(`${home}/config.toml`, `[projects.${tomlBasicString(realpathSync(project))}]\ntrust_level = "trusted"\n`);
  const script = new URL("./configure-codex-routing.mjs", import.meta.url).pathname;
  const run = (args) => Bun.spawnSync({ cmd: ["node", script, "--codex-bin", binary, ...args], cwd: project, env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const output = (result) => `${result.stdout.toString()}${result.stderr.toString()}`;
  try {
    expect(run(["--apply"]).exitCode).toBe(0);
    writeFileSync(`${project}/.codex/config.toml`, "[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"project mode\"\n");
    const status = run(["--status"]);
    expect(status.exitCode).toBe(0);
    const statusText = output(status);
    expect(statusText).toContain(`${FIELD_PATHS[0]}: "project mode" (layer: project)`);
    expect(statusText).toContain(`${FIELD_PATHS[1]}: ${JSON.stringify(HINT_TEXT)} (layer: user)`);
    const preview = run([]);
    expect(preview.exitCode).toBe(0);
    const previewText = output(preview);
    expect(previewText).toContain(`${FIELD_PATHS[0]}: "project mode" (layer: project)`);
    expect(previewText).toContain(`${FIELD_PATHS[1]}: ${JSON.stringify(HINT_TEXT)} (layer: user)`);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  // Real `codex` starts, several per case, each costing seconds. 30 s was a
  // budget this suite fit into only on an idle machine and timed out on a
  // loaded one. The budget bounds a hang, not the work, so it is generous.
}, 180_000);
