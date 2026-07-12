import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
} from "./configure-codex-routing.mjs";

const config = (mode, usage) => ({ features: { multi_agent_v2: { multi_agent_mode_hint_text: mode, usage_hint_text: usage } } });

describe("Codex routing pure logic", () => {
  test("parses preview, apply, status, disable, and binary flags", () => {
    expect(parseArgs([]).action).toBe("preview");
    expect(parseArgs(["--apply", "--replace-existing-policy", "--codex-bin", "/tmp/codex"]).apply).toBe(true);
    expect(parseArgs(["--status", "--require-effective"]).requireEffective).toBe(true);
    expect(parseArgs(["--disable"]).action).toBe("disable");
  });

  test("classifies absent, user conflict, installed, and drifted states", () => {
    const absent = config(undefined, undefined);
    const installedState = buildSnapshot(absent, "/tmp/codex/config.toml", "v1");
    installedState.managed = Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]));
    expect(classifyState({}, {}, null)).toBe("not installed");
    expect(classifyState(config("user", HINT_TEXT), {}, null)).toBe("user-conflict");
    expect(classifyState(config(HINT_TEXT, HINT_TEXT), config(HINT_TEXT, HINT_TEXT), installedState)).toBe("installed");
    expect(classifyState(config("changed", HINT_TEXT), config("changed", HINT_TEXT), installedState)).toBe("drifted");
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

test("real Codex App Server reads an isolated temporary home when available", async () => {
  const binary = Bun.which("codex");
  if (!binary) {
    console.info("SKIP: codex binary is not installed");
    return;
  }
  const home = mkdtempSync(`${tmpdir()}/smithers-codex-routing-test-`);
  const oldHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    const app = new AppServer(binary);
    try {
      await app.initialize();
      expect(app.codexHome).toBe(await Bun.$`realpath ${home}`.text().then((value) => value.trim()));
      const read = await app.request("config/read", { includeLayers: true, cwd: process.cwd() });
      const user = read.layers.find((layer) => layer.name?.type === "user");
      expect(user?.config).toEqual({});
      const written = await app.request("config/batchWrite", {
        edits: makeEdits(Object.fromEntries(FIELD_PATHS.map((path) => [path, HINT_TEXT]))),
        expectedVersion: user.version,
        reloadUserConfig: true,
      });
      expect(written.status).toBe("ok");
      expect(written.version).toStartWith("sha256:");
    } finally {
      app.close();
    }
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
