/** @jsxImportSource smthrs */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { Effect } from "effect";
import { Parallel, Subflow, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
// Relative import so these runs exercise THIS checkout's engine (the barrel
// would resolve to the installed package instead).
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

const END_TO_END_TIMEOUT_MS = 60_000;

// Approved root for runtime-generated workflow files. It must live inside the
// package so the generated modules can resolve bare imports (zod, react,
// smthrs) through the normal node_modules chain.
const genRoot = mkdtempSync(join(import.meta.dir, ".tmp-dynamic-wf-"));
const outsideRoot = mkdtempSync(join(import.meta.dir, ".tmp-dynamic-wf-outside-"));
afterAll(() => {
  rmSync(genRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

function buildSmithers() {
  return createTestSmithers({
    subflowOut: z.object({ topic: z.string() }),
  });
}

/**
 * Author a child workflow module at runtime, the way an architect agent
 * would: a .tsx file default-exporting a workflow built with smithers(...).
 * Each generated child gets its OWN sqlite db; the parent linkage the engine
 * writes (`parent_run_id`, the deterministic child run id) is what the tests
 * assert on.
 *
 * @param {string} relPath path under the approved root
 * @param {string} childDbPath sqlite file for the child workflow
 * @param {string} bodyJsx JSX source for the child workflow body
 * @returns {string} absolute path of the generated file
 */
function writeChildWorkflow(relPath, childDbPath, bodyJsx) {
  const source = `/** @jsxImportSource smthrs */
import { z } from "zod";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createSmithers, Task, Workflow } from "smthrs";

const { smithers, outputs } = createSmithers(
    {
        childOut: z.object({ topic: z.string() }),
        childAux: z.object({ topic: z.string() }),
    },
    { dbPath: ${JSON.stringify(childDbPath)} },
);

export default smithers((ctx: any) => (
    <Workflow name=${JSON.stringify(`generated-${basename(relPath, ".tsx")}`)}>
        ${bodyJsx}
    </Workflow>
), { output: outputs.childOut });
`;
  const abs = join(genRoot, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, source);
  return abs;
}

/**
 * Read the child runs the engine recorded in a generated child's own db.
 *
 * @param {string} childDbPath
 * @param {string} parentRunId
 * @returns {{ runId: string; parentRunId: string; status: string; workflowPath: string | null }[]}
 */
function readChildRuns(childDbPath, parentRunId) {
  const sqlite = new Database(childDbPath, { readonly: true });
  try {
    return /** @type {any[]} */ (
      sqlite
        .query(
          "SELECT run_id runId, parent_run_id parentRunId, status, workflow_path workflowPath FROM _smithers_runs WHERE parent_run_id = ? ORDER BY created_at_ms",
        )
        .all(parentRunId)
    );
  } finally {
    sqlite.close();
  }
}

describe("dynamically generated workflow files as Subflow children", () => {
  test(
    "loads a generated file from the approved root and propagates input and output through a durable parent-linked child run",
    async () => {
      const { smithers, outputs, tables, db, cleanup } = buildSmithers();
      try {
        const childDbPath = join(genRoot, "echo-child.sqlite");
        writeChildWorkflow(
          "generated/echo-child.tsx",
          childDbPath,
          `<Task id="echo" output={outputs.childOut} noRetry>
            {{ topic: String((ctx.input as any)?.topic ?? "missing") }}
        </Task>`,
        );
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-parent">
            <Subflow
              id="generated-child"
              output={outputs.subflowOut}
              workflow={{ path: "generated/echo-child.tsx" }}
              input={{ topic: "quarterly-report" }}
              retries={0}
            />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, rootDir: genRoot }));
        expect(result.status).toBe("finished");
        // Durable, parent-linked child run in the generated workflow's db.
        const childRuns = readChildRuns(childDbPath, result.runId);
        expect(childRuns).toHaveLength(1);
        expect(childRuns[0].status).toBe("finished");
        expect(childRuns[0].runId).toBe(`${result.runId}:child:generated-child:0`);
        // The child run's workflowPath is the generated module itself.
        expect(String(childRuns[0].workflowPath ?? "")).toContain("echo-child.tsx");
        // Durable subflow node on the parent side.
        const adapter = new SmithersDb(db);
        const nodes = await Effect.runPromise(adapter.listNodes(result.runId));
        const subflowNode = nodes.find((node) => node.nodeId === "generated-child");
        expect(subflowNode?.state).toBe("finished");
        // Input reached the child, and its output propagated back into the
        // parent's output target.
        const rows = await db.select().from(tables.subflowOut);
        expect(rows).toEqual([
          expect.objectContaining({
            runId: result.runId,
            nodeId: "generated-child",
            topic: "quarterly-report",
          }),
        ]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "rejects a generated path that escapes the approved root before importing it",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        // A real, loadable workflow module OUTSIDE the approved root that
        // records if it ever gets imported: containment, not existence,
        // must be what rejects it.
        const sentinelPath = join(outsideRoot, "evil-imported");
        writeFileSync(
          join(outsideRoot, "evil.js"),
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "imported\\n");
export default { build: () => null, opts: {} };
`,
        );
        const escapePath = join("..", basename(outsideRoot), "evil.js");
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-escape">
            <Subflow id="escapee" output={outputs.subflowOut} workflow={{ path: escapePath }} retries={0} />
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, rootDir: genRoot }));
        expect(result.status).toBe("failed");
        // The module outside the approved root was never even imported.
        expect(existsSync(sentinelPath)).toBe(false);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "resuming a cancelled parent run resumes the same durable child run without redoing finished child work",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const childDbPath = join(genRoot, "resume-child.sqlite");
        const journalPath = join(genRoot, "resume-journal");
        writeFileSync(journalPath, "");
        writeChildWorkflow(
          "generated/resume-child.tsx",
          childDbPath,
          `<Task id="step-one" output={outputs.childAux}>
            {() => {
                appendFileSync(${JSON.stringify(journalPath)}, "one\\n");
                return { topic: "one" };
            }}
        </Task>
        <Task id="step-two" output={outputs.childOut} dependsOn={["step-one"]}>
            {async () => {
                if (readFileSync(${JSON.stringify(journalPath)}, "utf8").includes("two-start")) {
                    return { topic: "two" };
                }
                appendFileSync(${JSON.stringify(journalPath)}, "two-start\\n");
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 20000);
                    (timer as any).unref?.();
                });
                return { topic: "late" };
            }}
        </Task>`,
        );
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-resume">
            <Subflow id="resume-sub" output={outputs.subflowOut} workflow={{ path: "generated/resume-child.tsx" }} />
          </Workflow>
        ));
        const runId = "dynamic-subflow-resume-run";
        const controller = new AbortController();
        const firstPromise = Effect.runPromise(
          runWorkflow(parent, {
            input: {},
            runId,
            rootDir: genRoot,
            signal: controller.signal,
          }),
        );
        // Cancel mid-child: step-one done, step-two started but incomplete.
        const deadline = Date.now() + 20_000;
        while (!readFileSync(journalPath, "utf8").includes("two-start") && Date.now() < deadline) {
          await sleep(10);
        }
        controller.abort();
        const first = await firstPromise;
        expect(first.status).toBe("cancelled");
        const second = await Effect.runPromise(
          runWorkflow(parent, {
            input: {},
            runId,
            resume: true,
            rootDir: genRoot,
          }),
        );
        expect(second.status).toBe("finished");
        // One durable child run, resumed (not restarted under a new id).
        const childRuns = readChildRuns(childDbPath, runId);
        expect(childRuns).toHaveLength(1);
        expect(childRuns[0].runId).toBe(`${runId}:child:resume-sub:0`);
        expect(childRuns[0].status).toBe("finished");
        // Finished child work was not re-executed on resume.
        const journal = readFileSync(journalPath, "utf8");
        expect(journal.split("\n").filter((line) => line === "one")).toHaveLength(1);
        expect(journal.split("\n").filter((line) => line === "two-start")).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the Subflow timeout applies to a generated child",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const childDbPath = join(genRoot, "sleepy-child.sqlite");
        writeChildWorkflow(
          "generated/sleepy-child.tsx",
          childDbPath,
          `<Task id="sleepy" output={outputs.childOut} noRetry>
            {async () => {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 20000);
                    (timer as any).unref?.();
                });
                return { topic: "too late" };
            }}
        </Task>`,
        );
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-timeout">
            <Subflow
              id="sleepy-sub"
              output={outputs.subflowOut}
              workflow={{ path: "generated/sleepy-child.tsx" }}
              timeoutMs={1000}
              retries={0}
            />
          </Workflow>
        ));
        const startedAt = Date.now();
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, rootDir: genRoot }));
        const elapsedMs = Date.now() - startedAt;
        expect(result.status).toBe("failed");
        // The parent must not wait out the child's 20s sleep (teardown may
        // spend a few seconds waiting for the aborted child to settle).
        expect(elapsedMs).toBeLessThan(15_000);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "cancelling the parent run cancels a running generated child",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const childDbPath = join(genRoot, "cancel-child.sqlite");
        const markerPath = join(genRoot, "cancel-marker");
        writeChildWorkflow(
          "generated/cancellable-child.tsx",
          childDbPath,
          `<Task id="cancellable" output={outputs.childOut} noRetry>
            {async () => {
                writeFileSync(${JSON.stringify(markerPath)}, "started\\n");
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 20000);
                    (timer as any).unref?.();
                });
                return { topic: "never" };
            }}
        </Task>`,
        );
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-cancel">
            <Subflow
              id="cancel-sub"
              output={outputs.subflowOut}
              workflow={{ path: "generated/cancellable-child.tsx" }}
              retries={0}
            />
          </Workflow>
        ));
        const controller = new AbortController();
        const runPromise = Effect.runPromise(
          runWorkflow(parent, {
            input: {},
            rootDir: genRoot,
            signal: controller.signal,
          }),
        );
        // Wait until the generated child is provably executing, then abort.
        const deadline = Date.now() + 20_000;
        while (!existsSync(markerPath) && Date.now() < deadline) {
          await sleep(10);
        }
        expect(existsSync(markerPath)).toBe(true);
        controller.abort();
        const result = await runPromise;
        expect(result.status).toBe("cancelled");
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "generated-file subflows respect the parent maxConcurrency budget",
    async () => {
      const { smithers, outputs, cleanup } = buildSmithers();
      try {
        const journalPath = join(genRoot, "concurrency-journal");
        writeFileSync(journalPath, "");
        for (const id of ["alpha", "beta"]) {
          writeChildWorkflow(
            `generated/${id}-child.tsx`,
            join(genRoot, `${id}-child.sqlite`),
            `<Task id="work" output={outputs.childOut} noRetry>
            {async () => {
                appendFileSync(${JSON.stringify(journalPath)}, "start:${id}\\n");
                await new Promise((resolve) => setTimeout(resolve, 250));
                appendFileSync(${JSON.stringify(journalPath)}, "end:${id}\\n");
                return { topic: "${id}" };
            }}
        </Task>`,
          );
        }
        const parent = smithers(() => (
          <Workflow name="dynamic-subflow-concurrency">
            <Parallel>
              <Subflow
                id="sub-alpha"
                output={outputs.subflowOut}
                workflow={{ path: "generated/alpha-child.tsx" }}
                retries={0}
              />
              <Subflow
                id="sub-beta"
                output={outputs.subflowOut}
                workflow={{ path: "generated/beta-child.tsx" }}
                retries={0}
              />
            </Parallel>
          </Workflow>
        ));
        const result = await Effect.runPromise(
          runWorkflow(parent, {
            input: {},
            rootDir: genRoot,
            maxConcurrency: 1,
          }),
        );
        expect(result.status).toBe("finished");
        const lines = readFileSync(journalPath, "utf8").trim().split("\n");
        expect(lines).toHaveLength(4);
        // With the parent budget pinned to 1 slot the children may not
        // overlap: each start is immediately followed by its own end.
        expect(lines[0].startsWith("start:")).toBe(true);
        expect(lines[1]).toBe(lines[0].replace("start:", "end:"));
        expect(lines[2].startsWith("start:")).toBe(true);
        expect(lines[3]).toBe(lines[2].replace("start:", "end:"));
        expect(lines[0]).not.toBe(lines[2]);
      } finally {
        cleanup();
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
