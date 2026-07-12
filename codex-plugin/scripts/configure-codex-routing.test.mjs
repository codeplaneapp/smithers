import { describe, expect, test } from "bun:test";
import {
  AppServer,
  FIELD_PATHS,
  HINT_TEXT,
  buildSnapshot,
  classifyState,
  currentFields,
  makeEdits,
  parseArgs,
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
  if (!binary) return;
  const home = `${await Bun.$`mktemp -d`.text()}`.trim();
  try {
    process.env.CODEX_HOME = home;
    const app = new AppServer(binary);
    try {
      await app.initialize();
      expect(app.codexHome).toBe(await Bun.$`realpath ${home}`.text().then((value) => value.trim()));
    } finally {
      app.close();
    }
  } finally {
    await Bun.$`rm -rf ${home}`;
  }
});
