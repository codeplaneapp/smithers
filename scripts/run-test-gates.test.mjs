import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runTestGates, TEST_GATE_SCRIPTS } from "./run-test-gates.mjs";

const silent = () => {};

test("pins the canonical gate roster", () => {
  assert.deepEqual(TEST_GATE_SCRIPTS, [
    "scripts/run-test-gates.test.mjs",
    "scripts/run-workspace-test-suite.test.mjs",
    "scripts/check-production-licenses.test.mjs",
    "scripts/check-single-effect-version.mjs",
    "scripts/check-dependency-boundaries.mjs",
    "scripts/check-no-direct-db-access.mjs",
    "scripts/check-docs.mjs",
    "scripts/check-llms.mjs",
    "scripts/check-sota.mjs",
    "scripts/check-eval-cases.mjs",
    "scripts/check-smithers-test-script.mjs",
  ]);
});

test("runs every gate in order when they succeed", () => {
  const cwd = resolve("test-gate-fixture");
  const calls = [];
  const status = runTestGates(["first.mjs", "second.mjs"], {
    cwd,
    executable: "node",
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
    [
      ["node", resolve(cwd, "first.mjs")],
      ["node", resolve(cwd, "second.mjs")],
    ],
  );
  assert.ok(calls.every(({ options }) => options.cwd === cwd && options.stdio === "inherit"));
});

test("stops immediately and preserves the first nonzero status", () => {
  const calls = [];
  const statuses = [0, 23, 0];
  const status = runTestGates(["first.mjs", "failing.mjs", "must-not-run.mjs"], {
    log: silent,
    reportError: silent,
    spawnSync(_command, [gate]) {
      calls.push(gate);
      return { status: statuses[calls.length - 1], signal: null };
    },
  });

  assert.equal(status, 23);
  assert.deepEqual(calls.map((gate) => gate.split(/[\\/]/).at(-1)), ["first.mjs", "failing.mjs"]);
});

test("treats launch errors and signal termination as failures", () => {
  const launchErrorStatus = runTestGates(["broken.mjs"], {
    log: silent,
    reportError: silent,
    spawnSync() {
      return { error: new Error("spawn failed"), status: null, signal: null };
    },
  });
  const signalStatus = runTestGates(["terminated.mjs"], {
    log: silent,
    reportError: silent,
    spawnSync() {
      return { status: null, signal: "SIGTERM" };
    },
  });

  assert.equal(launchErrorStatus, 1);
  assert.equal(signalStatus, 1);
});
