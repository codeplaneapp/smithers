// Real-backend tests for the Hermes plugin's Smithers tool handlers
// (src/hermes-plugin/tools.py) and their advertised schemas
// (src/hermes-plugin/schemas.py).
//
// These are the argv/contract regressions from the plugin review:
//   - `smithers_output` must send the node id POSITIONALLY (`output <run> <node>`);
//     the CLI has no `--node` flag, and the node id is required.
//   - the `.tsx` launch must go through `up --input '{"prompt":...}'`; `up` has no
//     `--prompt` flag (only `workflow run` does), so `up --prompt` is rejected.
//   - the SMITHERS_OUTPUT schema must mark `node` required, not "optional /
//     defaults to the run output".
//
// No mocks: the argv-contract cases drive tools.py through the real Python
// interpreter against a real recording CLI binary (a fixture that emits real
// JSON and records the argv it received); the end-to-end cases drive tools.py
// against the REAL `smithers` CLI over a real SQLite store seeded by a real run.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";
import { makeTempDirPath } from "../../../packages/testing/src/cleanup/tempDir.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const PKG_DIR = resolve(REPO_ROOT, "apps/cli/src/hermes-plugin");
const PYTHON = Bun.which("python3");

// The plugin dir has a hyphen so it is not importable as a normal package;
// register a synthetic `hermes_plugin` package pointing at it, then load only
// the submodules the tools need (this mirrors how Hermes loads the plugin by
// path rather than by import name).
const LOADER = [
  "import importlib.util, sys, types, json, os",
  `PKG_DIR = ${JSON.stringify(PKG_DIR)}`,
  'pkg = types.ModuleType("hermes_plugin")',
  "pkg.__path__ = [PKG_DIR]",
  'sys.modules["hermes_plugin"] = pkg',
  'for sub in ("smithers_cli", "schemas", "tools"):',
  '    spec = importlib.util.spec_from_file_location(f"hermes_plugin.{sub}", f"{PKG_DIR}/{sub}.py")',
  "    m = importlib.util.module_from_spec(spec)",
  '    sys.modules[f"hermes_plugin.{sub}"] = m',
  "    spec.loader.exec_module(m)",
  'tools = sys.modules["hermes_plugin.tools"]',
  'schemas = sys.modules["hermes_plugin.schemas"]',
].join("\n");

/**
 * @param {string} body Python that may reference `tools`, `schemas`, `json`.
 * @param {{ env?: Record<string, string>; cwd?: string }} [opts]
 */
function runPython(body, opts = {}) {
  const res = spawnSync(PYTHON, ["-c", `${LOADER}\n${body}\n`], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    timeout: 200_000,
  });
  if (res.status !== 0) {
    throw new Error(`python driver failed (${res.status}):\n${res.stderr}\n${res.stdout}`);
  }
  return res.stdout;
}

// A real executable that behaves like `smithers` for argv-contract assertions:
// it appends the exact argv it received (as JSON) to $REC and prints a real
// JSON row on stdout, so tools.py's result-parsing path runs for real too.
function writeRecordingCli() {
  const dir = makeTempDirPath("smithers-fake-cli-");
  const js = join(dir, "fake-smithers.js");
  writeFileSync(
    js,
    [
      "const fs = require('fs');",
      "const argv = process.argv.slice(2);",
      "fs.appendFileSync(process.env.REC, JSON.stringify(argv) + '\\n');",
      "process.stdout.write(JSON.stringify({ runId: 'run-xyz', nodeId: argv[1] ?? null, status: 'finished' }) + '\\n');",
    ].join("\n"),
  );
  const bin = join(dir, "smithers");
  writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${js} "$@"\n`);
  chmodSync(bin, 0o755);
  const rec = join(dir, "rec.log");
  writeFileSync(rec, "");
  return { bin, rec };
}

const describeMaybe = PYTHON ? describe : describe.skip;

describeMaybe("hermes-plugin tool argv contract (recording CLI fixture)", () => {
  test("smithers_output sends the node id positionally, never as --node", () => {
    const { bin, rec } = writeRecordingCli();
    const out = runPython('print(tools.smithers_output({"run_id": "r1", "node": "n1"}))', {
      env: { SMITHERS_BIN: bin, REC: rec },
    });
    // The tool parsed the fixture's real JSON row into an ok envelope.
    expect(JSON.parse(out.trim())).toMatchObject({ ok: true, exit_code: 0 });
    const argv = JSON.parse(readFileSync(rec, "utf8").trim());
    expect(argv).toEqual(["output", "r1", "n1"]);
    expect(argv).not.toContain("--node");
  });

  test("smithers_output without a node id errors before shelling out", () => {
    const { bin, rec } = writeRecordingCli();
    const out = runPython('print(tools.smithers_output({"run_id": "r1"}))', { env: { SMITHERS_BIN: bin, REC: rec } });
    expect(JSON.parse(out.trim())).toEqual({ error: "node is required" });
    // Nothing was executed.
    expect(readFileSync(rec, "utf8").trim()).toBe("");
  });

  test("smithers_run maps a .tsx prompt to `up --input`, never `up --prompt`", () => {
    const { bin, rec } = writeRecordingCli();
    runPython('print(tools.smithers_run({"workflow": "wf.tsx", "prompt": "hi there", "detach": False}))', {
      env: { SMITHERS_BIN: bin, REC: rec },
    });
    const argv = JSON.parse(readFileSync(rec, "utf8").trim());
    expect(argv[0]).toBe("up");
    expect(argv[1]).toBe("wf.tsx");
    expect(argv).not.toContain("--prompt");
    const inputIdx = argv.indexOf("--input");
    expect(inputIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[inputIdx + 1])).toEqual({ prompt: "hi there" });
  });

  test("smithers_run keeps `--prompt` for a named (non-.tsx) workflow", () => {
    const { bin, rec } = writeRecordingCli();
    runPython('print(tools.smithers_run({"workflow": "implement", "prompt": "do it", "detach": True}))', {
      env: { SMITHERS_BIN: bin, REC: rec },
    });
    const argv = JSON.parse(readFileSync(rec, "utf8").trim());
    expect(argv.slice(0, 5)).toEqual(["workflow", "run", "implement", "--prompt", "do it"]);
    expect(argv).toContain("--detach");
  });

  test("an explicit --input wins over prompt on the .tsx launch", () => {
    const { bin, rec } = writeRecordingCli();
    runPython(
      'print(tools.smithers_run({"workflow": "wf.tsx", "input": {"a": 1}, "prompt": "ignored", "detach": False}))',
      { env: { SMITHERS_BIN: bin, REC: rec } },
    );
    const argv = JSON.parse(readFileSync(rec, "utf8").trim());
    const inputIdx = argv.indexOf("--input");
    expect(JSON.parse(argv[inputIdx + 1])).toEqual({ a: 1 });
    expect(argv).not.toContain("--prompt");
  });

  test("SMITHERS_OUTPUT schema marks node required", () => {
    const out = runPython('print(json.dumps(schemas.SMITHERS_OUTPUT["parameters"]["required"]))');
    expect(JSON.parse(out.trim())).toEqual(["run_id", "node"]);
  });
});

describeMaybe("hermes-plugin tools against the real smithers CLI", () => {
  const realCliEnv = {
    SMITHERS_BIN: `${process.execPath} ${CLI_ENTRY}`,
    SMITHERS_NO_SKILL_REFRESH: "1",
    SMITHERS_NO_UPDATE_CHECK: "1",
    CI: "1",
  };

  test("smithers_output returns a node row via the positional CLI contract", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const run = runSmithers(["up", "workflow.tsx"], { cwd: repo.dir, format: "json" });
    expect(run.exitCode).toBe(0);
    const runId = run.json?.runId;
    expect(runId).toBeString();

    const out = runPython(
      `print(tools.smithers_output({"run_id": ${JSON.stringify(runId)}, "node": "write-result"}))`,
      { cwd: repo.dir, env: realCliEnv },
    );
    const envelope = JSON.parse(out.trim());
    // The real CLI accepted `output <runId> write-result` and returned the row.
    expect(envelope.ok).toBe(true);
    expect(envelope.exit_code).toBe(0);
    expect(JSON.stringify(envelope)).toContain("fixture workflow ran");
  }, 120_000);

  test("smithers_run launches a .tsx workflow and its prompt reaches input.prompt", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    const marker = `hermes-prompt-${Date.now()}`;
    const out = runPython(
      `print(tools.smithers_run({"workflow": "workflow.tsx", "prompt": ${JSON.stringify(marker)}, "detach": False}))`,
      { cwd: repo.dir, env: realCliEnv },
    );
    expect(JSON.parse(out.trim()).ok).toBe(true);

    const db = new Database(repo.path("smithers.db"), { readonly: true });
    try {
      const row = db.query('select prompt from "result" where prompt = ? limit 1').get(marker);
      expect(row?.prompt).toBe(marker);
    } finally {
      db.close();
    }
  }, 120_000);
});
