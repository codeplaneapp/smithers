import { describe, expect, test } from "bun:test";

import { toolSpecs } from "../src/openclaw-plugin/toolSpecs.js";

/** @param {string} name */
function toArgs(name, params) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`no tool ${name}`);
  return spec.toArgs(params);
}

describe("openclaw plugin toArgs — CLI contract", () => {
  test("smithers_run routes a .tsx workflow to `up` and folds prompt into --input (up has no --prompt)", () => {
    expect(toArgs("smithers_run", { workflow: "./w.tsx", prompt: "do X" })).toEqual([
      "up",
      "./w.tsx",
      "--input",
      JSON.stringify({ prompt: "do X" }),
      "--detach",
      "--started-by-harness",
      "openclaw",
    ]);
  });

  test("smithers_run prefers explicit --input over prompt on the `up` branch", () => {
    expect(toArgs("smithers_run", { workflow: "./w.tsx", prompt: "ignored", input: { a: 1 } })).toEqual([
      "up",
      "./w.tsx",
      "--input",
      JSON.stringify({ a: 1 }),
      "--detach",
      "--started-by-harness",
      "openclaw",
    ]);
  });

  test("smithers_run routes a workflow id to `workflow run` and keeps --prompt", () => {
    expect(toArgs("smithers_run", { workflow: "implement", prompt: "do X", detach: false })).toEqual([
      "workflow",
      "run",
      "implement",
      "--prompt",
      "do X",
      "--started-by-harness",
      "openclaw",
    ]);
  });

  test("smithers_run keeps attribution prompt separate from workflow prompt", () => {
    expect(
      toArgs("smithers_run", {
        workflow: "implement",
        prompt: "workflow prompt",
        started_by_session: "session-1",
        started_by_prompt: "launch context",
      }),
    ).toEqual([
      "workflow",
      "run",
      "implement",
      "--prompt",
      "workflow prompt",
      "--detach",
      "--started-by-harness",
      "openclaw",
      "--started-by-session",
      "session-1",
      "--started-by-prompt",
      "launch context",
    ]);
  });

  test("smithers_output emits two positionals `<runId> <nodeId>` and requires node", () => {
    expect(toArgs("smithers_output", { run_id: "r1", node: "n1" })).toEqual(["output", "r1", "n1"]);
    expect(() => toArgs("smithers_output", { run_id: "r1" })).toThrow(/node is required/);
    // Never emits a --node flag (the CLI `output` command has none).
    const args = toArgs("smithers_output", { run_id: "r1", node: "n1" });
    expect(args).not.toContain("--node");
  });

  test("smithers_inspect and smithers_ps match the CLI shape", () => {
    expect(toArgs("smithers_inspect", { run_id: "r1" })).toEqual(["inspect", "r1", "--json"]);
    expect(toArgs("smithers_ps", {})).toEqual(["ps", "--json"]);
  });

  test("smithers_approve/deny build `<verb> <runId>` with optional --node", () => {
    expect(toArgs("smithers_approve", { run_id: "r1", node: "gate" })).toEqual(["approve", "r1", "--node", "gate"]);
    expect(toArgs("smithers_deny", { run_id: "r1" })).toEqual(["deny", "r1"]);
  });
});
