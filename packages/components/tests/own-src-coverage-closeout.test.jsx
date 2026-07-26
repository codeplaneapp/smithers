/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { ScanFixVerify } from "../src/components/index.js";
import { useOptionalSmithersContext } from "../src/components/useOptionalSmithersContext.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };

async function render(el) {
  const renderer = new SmithersRenderer();
  return renderer.render(el);
}

async function renderWithOutputs(el, outputs) {
  const ctx = new SmithersCtx({
    runId: "test-run",
    iteration: 0,
    input: {},
    outputs,
  });
  return render(<SmithersContext.Provider value={ctx}>{el}</SmithersContext.Provider>);
}

describe("ScanFixVerify single (non-array) fixer expansion", () => {
  test("reuses the single fixer agent for every discovered issue", async () => {
    const scan = await renderWithOutputs(
      <ScanFixVerify
        id="sfv"
        scanner={agent}
        fixer={otherAgent}
        verifier={agent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
        maxRetries={2}
      />,
      {
        scan_out: [
          {
            nodeId: "sfv-scan",
            iteration: 0,
            issues: ["broken widget", "leaky abstraction"],
          },
        ],
      },
    );

    // With the scan row present, one fix task is emitted per issue and each
    // task gets the single (non-array) fixer agent via fixerForIssue's
    // !Array.isArray(props.fixer) branch.
    const fixTasks = scan.tasks.filter((task) => task.nodeId.startsWith("sfv-fix-"));
    expect(fixTasks.map((task) => task.nodeId)).toEqual(["sfv-fix-0", "sfv-fix-1"]);
    for (const task of fixTasks) {
      expect(task.agent).toBe(otherAgent);
    }
  });
});

describe("useOptionalSmithersContext error handling", () => {
  test("rethrows errors that are not invalid-hook-call errors", () => {
    const original = React.useContext;
    const sentinel = new Error("database connection exploded");
    React.useContext = () => {
      throw sentinel;
    };
    try {
      expect(() => useOptionalSmithersContext()).toThrow(sentinel);
    } finally {
      React.useContext = original;
    }
  });

  test("swallows invalid-hook-call errors and returns null", () => {
    const original = React.useContext;
    React.useContext = () => {
      throw new Error("Invalid hook call. Hooks can only be called ...");
    };
    try {
      expect(useOptionalSmithersContext()).toBeNull();
    } finally {
      React.useContext = original;
    }
  });
});
