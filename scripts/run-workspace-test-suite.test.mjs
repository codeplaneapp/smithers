import assert from "node:assert/strict";
import test from "node:test";

import {
  runWorkspaceTestSuite,
  WORKSPACE_TEST_PHASES,
} from "./run-workspace-test-suite.mjs";

const silent = () => {};

test("pins the parallel workspace phase and exclusive CLI phase", () => {
  assert.deepEqual(WORKSPACE_TEST_PHASES, [
    {
      label: "workspace packages except CLI",
      args: [
        "--filter",
        "!@smithers-orchestrator/cli",
        "-r",
        "--workspace-concurrency=4",
        "--no-bail",
        "test",
      ],
    },
    {
      label: "CLI (exclusive native-compiler lane)",
      args: ["--dir", "apps/cli", "test"],
    },
  ]);
});

test("runs the CLI only after the other workspace process exits", () => {
  const calls = [];
  const status = runWorkspaceTestSuite({
    cwd: "/repo",
    executable: "pnpm-test",
    platform: "linux",
    log: silent,
    reportError: silent,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, signal: null };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    WORKSPACE_TEST_PHASES.map(({ args }) => ["pnpm-test", ...args]),
  );
  assert.ok(
    calls.every(
      ({ options }) =>
        options.cwd === "/repo" &&
        options.shell === false &&
        options.stdio === "inherit",
    ),
  );
});

test("always attempts both phases and preserves the first failure status", () => {
  const calls = [];
  const statuses = [23, 41];
  const status = runWorkspaceTestSuite({
    log: silent,
    reportError: silent,
    spawnSync(_command, args) {
      calls.push(args);
      return { status: statuses[calls.length - 1], signal: null };
    },
  });

  assert.equal(status, 23);
  assert.equal(calls.length, 2);
});

test("treats thrown, reported, and signal launch failures as failures", () => {
  for (const firstResult of [
    () => {
      throw new Error("spawn failed");
    },
    () => ({ error: new Error("spawn failed"), status: null, signal: null }),
    () => ({ status: null, signal: "SIGTERM" }),
  ]) {
    let calls = 0;
    const status = runWorkspaceTestSuite({
      platform: "win32",
      log: silent,
      reportError: silent,
      spawnSync(_command, _args, options) {
        calls += 1;
        assert.equal(options.shell, true);
        if (calls === 1) return firstResult();
        return { status: 0, signal: null };
      },
    });

    assert.equal(status, 1);
    assert.equal(calls, 2);
  }
});
