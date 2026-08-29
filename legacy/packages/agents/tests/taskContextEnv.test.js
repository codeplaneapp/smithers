import { describe, expect, test } from "bun:test";
import { INSIDE_RUN_ENV_VAR, taskContextEnv } from "../src/BaseCliAgent/taskContextEnv.js";

describe("taskContextEnv", () => {
  test("returns an empty object for missing context", () => {
    expect(taskContextEnv(undefined)).toEqual({});
    expect(taskContextEnv(null)).toEqual({});
  });

  test("maps a full task context to SMITHERS_* vars as strings", () => {
    expect(
      taskContextEnv({
        runId: "run-1",
        nodeId: "implement",
        iteration: 2,
        attempt: 1,
      }),
    ).toEqual({
      SMITHERS_RUN_ID: "run-1",
      SMITHERS_NODE_ID: "implement",
      SMITHERS_INSIDE_RUN: "run-1/implement",
      SMITHERS_ITERATION: "2",
      SMITHERS_ATTEMPT: "1",
    });
  });

  test("includes iteration 0 but omits blank/invalid fields", () => {
    expect(
      taskContextEnv({
        runId: "",
        nodeId: "implement",
        iteration: 0,
        // @ts-expect-error intentionally invalid attempt
        attempt: "nope",
      }),
    ).toEqual({
      SMITHERS_NODE_ID: "implement",
      SMITHERS_ITERATION: "0",
    });
  });

  // The recursion guard the orchestration skills read: an agent running inside a
  // node must never route its prompt back through `smithers up`. Without a
  // marker at spawn, a codex node with the smithers skill installed hijacks its
  // own prompt into a child run (bug 01kzweq27e2645ty9x5yezkrwk).
  test("marks every spawned node agent as being inside a run", () => {
    expect(INSIDE_RUN_ENV_VAR).toBe("SMITHERS_INSIDE_RUN");
    expect(taskContextEnv({ runId: "run-1", nodeId: "review" })[INSIDE_RUN_ENV_VAR]).toBe("run-1/review");
    // Node id is optional; the run id alone still marks the process as inside.
    expect(taskContextEnv({ runId: "run-1" })[INSIDE_RUN_ENV_VAR]).toBe("run-1");
    // No run means no node, so nothing is marked.
    expect(taskContextEnv({ nodeId: "review" })[INSIDE_RUN_ENV_VAR]).toBeUndefined();
    expect(taskContextEnv(null)[INSIDE_RUN_ENV_VAR]).toBeUndefined();
  });
});
