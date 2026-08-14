/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";

const TIMEOUT_MS = 30_000;

function buildRuntime(name) {
  const runtime = createTestSmithers(outputSchemas);
  const workflow = runtime.smithers(() => (
    <Workflow name={name}>
      <Task id="t" output={runtime.outputs.outputA}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
  return { ...runtime, workflow, adapter: new SmithersDb(runtime.db) };
}

describe("logDir override wiring", () => {
  test(
    "a custom logDir receives the NDJSON stream, starting with RunStarted",
    async () => {
      const { workflow, cleanup } = buildRuntime("logdir-custom");
      const rootDir = makeTempDirPath("smithers-logdir-");
      try {
        const runId = "logdir-custom-run";
        const result = await Effect.runPromise(
          runWorkflow(workflow, {
            input: {},
            runId,
            rootDir,
            logDir: "custom-logs",
          }),
        );
        expect(result.status).toBe("finished");
        const streamPath = join(rootDir, "custom-logs", "stream.ndjson");
        expect(existsSync(streamPath)).toBe(true);
        const lines = readFileSync(streamPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0].type).toBe("RunStarted");
        expect(lines[0].runId).toBe(runId);
        // The default location must not also be created.
        expect(existsSync(join(rootDir, ".smithers", "executions", runId, "logs"))).toBe(false);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "logDir=null disables NDJSON logging while events still persist to the DB",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime("logdir-null");
      const rootDir = makeTempDirPath("smithers-logdir-null-");
      try {
        const runId = "logdir-null-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir, logDir: null }));
        expect(result.status).toBe("finished");
        expect(existsSync(join(rootDir, ".smithers", "executions", runId, "logs"))).toBe(false);
        const events = await adapter.listEvents(runId, -1, 100);
        expect(events.some((event) => event.type === "RunStarted")).toBe(true);
        expect(events.some((event) => event.type === "RunFinished")).toBe(true);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("run row VCS metadata capture", () => {
  test(
    "a git repo with a commit yields git type, root, and HEAD revision",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime("vcs-git");
      const repoDir = makeTempDirPath("smithers-vcs-git-");
      try {
        execFileSync("git", ["init", "-q"], { cwd: repoDir });
        execFileSync(
          "git",
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "seed"],
          { cwd: repoDir },
        );
        const head = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoDir,
          encoding: "utf8",
        }).trim();
        const runId = "vcs-git-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: repoDir }));
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.vcsType).toBe("git");
        expect(resolve(String(run?.vcsRoot))).toBe(resolve(repoDir));
        expect(run?.vcsRevision).toBe(head);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a git repo with zero commits records git type with a null revision",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime("vcs-git-empty");
      const repoDir = makeTempDirPath("smithers-vcs-git-empty-");
      try {
        execFileSync("git", ["init", "-q"], { cwd: repoDir });
        const runId = "vcs-git-empty-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: repoDir }));
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.vcsType).toBe("git");
        expect(run?.vcsRevision).toBeNull();
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a plain directory records no VCS metadata at all",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime("vcs-none");
      const plainDir = makeTempDirPath("smithers-vcs-none-");
      try {
        const runId = "vcs-none-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: plainDir }));
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.vcsType).toBeNull();
        expect(run?.vcsRoot).toBeNull();
        expect(run?.vcsRevision).toBeNull();
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("workflowName persistence from the rendered root", () => {
  test(
    "a named Workflow root persists its name on the run row",
    async () => {
      const { workflow, adapter, cleanup } = buildRuntime("named-flow");
      const rootDir = makeTempDirPath("smithers-name-");
      try {
        const runId = "named-flow-run";
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir }));
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.workflowName).toBe("named-flow");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a nameless Workflow root falls back to the placeholder name",
    async () => {
      const runtime = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(runtime.db);
      const rootDir = makeTempDirPath("smithers-nameless-");
      try {
        const workflow = runtime.smithers(() => (
          <Workflow>
            <Task id="t" output={runtime.outputs.outputA}>
              {{ value: 1 }}
            </Task>
          </Workflow>
        ));
        const runId = "nameless-flow-run";
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir }));
        expect(result.status).toBe("finished");
        const run = await Effect.runPromise(adapter.getRun(runId));
        expect(run?.workflowName).toBe("workflow");
      } finally {
        runtime.cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
