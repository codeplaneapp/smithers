/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

describe("terminal task repair", () => {
  test("runs after retry and agent fallback exhaustion, receives context, and retries the original once", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let repaired = false;
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let repairCalls = 0;
    let repairPrompt = "";
    const primary = {
      id: "primary",
      tools: {},
      async generate() {
        primaryCalls += 1;
        if (repaired) return { output: { value: 42 } };
        throw new SmithersError("TRANSIENT_TEST", "upstream temporarily unavailable");
      },
    };
    const fallback = {
      id: "fallback",
      tools: {},
      async generate() {
        fallbackCalls += 1;
        throw new SmithersError("TERMINAL_TEST", "missing required marker file");
      },
    };
    const repairAgent = {
      id: "repair",
      tools: {},
      async generate(args) {
        repairCalls += 1;
        repairPrompt = String(args.prompt ?? args.messages?.at(-1)?.content ?? "");
        repaired = true;
        return { output: { value: 1 } };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="repair-after-fallback">
        <Task
          id="build"
          output={outputs.outputA}
          agent={[primary, fallback]}
          retries={1}
          retryPolicy={{ retryable: (error) => error?.code !== "TERMINAL_TEST", initialDelayMs: 0 }}
          repair={{
            agent: repairAgent,
            output: outputs.outputB,
            instructions: "Create the missing marker and report what changed.",
          }}
        >
          build the artifact
        </Task>
      </Workflow>
    ));

    try {
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result).toMatchObject({ status: "finished" });
      expect({ primaryCalls, fallbackCalls, repairCalls }).toEqual({
        primaryCalls: 2,
        fallbackCalls: 1,
        repairCalls: 1,
      });
      expect(repairPrompt).toContain('"nodeId": "build"');
      expect(repairPrompt).toContain("missing required marker file");
      expect(repairPrompt).toContain('"attempt": 1');
      expect(repairPrompt).toContain('"attempt": 2');
      expect(repairPrompt).toContain('"worktree"');
    } finally {
      cleanup();
    }
  }, 20_000);

  test("a failed repair exhausts its bounded budget without repairing again", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    let originalCalls = 0;
    let repairCalls = 0;
    const workflow = smithers(() => (
      <Workflow name="repair-fails">
        <Task
          id="broken"
          output={outputs.outputA}
          agent={{
            id: "broken",
            tools: {},
            async generate() {
              originalCalls += 1;
              throw new SmithersError("TERMINAL_TEST", "cannot proceed", { failureRetryable: false });
            },
          }}
          noRetry
          repair={{
            output: outputs.outputB,
            agent: {
              id: "bad-repair",
              tools: {},
              async generate() {
                repairCalls += 1;
                throw new SmithersError("REPAIR_TEST_FAILURE", "repair could not fix state", {
                  failureRetryable: false,
                });
              },
            },
          }}
        >
          fail terminally
        </Task>
      </Workflow>
    ));

    try {
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(originalCalls).toBe(1);
      expect(repairCalls).toBe(1);
      const repairAttempts = await adapter.listAttempts(result.runId, "__smithers_repair__:broken", 0);
      expect(repairAttempts).toHaveLength(1);
      expect(repairAttempts[0].state).toBe("failed");
    } finally {
      cleanup();
    }
  }, 20_000);

  test("resume restarts a crash-interrupted repair from durable attempt state", async () => {
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "crash-mid-task-repair";
    const startedPath = `${dbPath}.repair-started`;
    const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.js");
    const schemaPath = resolve(import.meta.dir, "../../smithers/tests/schema.js");
    const script = `
import React from "react";
import { writeFileSync } from "node:fs";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { outputSchemas } from ${JSON.stringify(schemaPath)};
import { Effect } from "effect";
const api = createSmithers(outputSchemas, { dbPath: ${JSON.stringify(dbPath)} });
const original = { id: "terminal", tools: {}, async generate() {
  const error = new Error("missing durable precondition");
  error.details = { failureRetryable: false };
  throw error;
} };
const repair = { id: "hanging-repair", tools: {}, async generate() {
  writeFileSync(${JSON.stringify(startedPath)}, "started");
  return new Promise(() => {});
} };
const workflow = api.smithers(() => React.createElement(Workflow, { name: "repair-crash" },
  React.createElement(Task, {
    id: "work", output: api.outputs.outputA, agent: original, noRetry: true,
    repair: { agent: repair, output: api.outputs.outputB },
  }, "perform work"),
));
await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: ${JSON.stringify(runId)} }));
`;
    const child = spawn(process.execPath, ["-e", script], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let childStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      childStderr += chunk;
    });
    try {
      for (let index = 0; index < 1_500 && !existsSync(startedPath) && child.exitCode == null; index += 1) {
        await Bun.sleep(10);
      }
      if (!existsSync(startedPath)) throw new Error(`repair child did not start: ${childStderr}`);
      child.kill("SIGKILL");
      await new Promise((resolveExit) => child.once("close", resolveExit));

      let repaired = false;
      const resumedWorkflow = smithers(() => (
        <Workflow name="repair-crash">
          <Task
            id="work"
            output={outputs.outputA}
            agent={{
              id: "terminal",
              tools: {},
              async generate() {
                if (repaired) return { output: { value: 9 } };
                const error = new Error("missing durable precondition");
                error.details = { failureRetryable: false };
                throw error;
              },
            }}
            noRetry
            repair={{
              output: outputs.outputB,
              agent: {
                id: "resumed-repair",
                tools: {},
                async generate() {
                  repaired = true;
                  return { output: { value: 1 } };
                },
              },
            }}
          >
            perform work
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(
        runWorkflow(resumedWorkflow, { input: {}, runId, resume: true, force: true }),
      );
      expect(result).toMatchObject({ status: "finished" });
      const repairAttempts = await adapter.listAttempts(runId, "__smithers_repair__:work", 0);
      expect(repairAttempts.map((attempt) => attempt.state).sort()).toEqual(["cancelled", "finished"]);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
      cleanup();
    }
  }, 60_000);
});
