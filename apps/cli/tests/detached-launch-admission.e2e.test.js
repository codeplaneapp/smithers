import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 120_000;

function expectNoRunRow(repo, runId) {
  const dbPath = repo.path("smithers.db");
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db.query("select name from sqlite_master where type = 'table' and name = '_smithers_runs'").get();
    if (!table) return;
    expect(db.query("select run_id from _smithers_runs where run_id = ?").get(runId)).toBeNull();
  } finally {
    db.close();
  }
}

function validSlowWorkflow() {
  return [
    "/** @jsxImportSource smthrs */",
    'import { createSmithers, Workflow, Task } from "smthrs";',
    'import { z } from "zod";',
    "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
    "export default smithers(() => (",
    '  <Workflow name="admission-fixture">',
    '    <Task id="slow" output={outputs.result}>{async () => {',
    "      await Bun.sleep(1500);",
    "      return { ok: true };",
    "    }}</Task>",
    "  </Workflow>",
    "));",
    "",
  ].join("\n");
}

describe("detached launch admission", () => {
  test(
    "up -d preflights TSX syntax errors and never spawns or prints a run id",
    () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write(
        "broken.tsx",
        [
          "/** @jsxImportSource smthrs */",
          "const prompt = `an unescaped `backtick` breaks parsing`;",
          "export default prompt;",
          "",
        ].join("\n"),
      );

      const result = runSmithers(["up", "broken.tsx", "-d", "--run-id", "tsx-parse-failure"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/broken\.tsx:\d+|broken\.tsx.*SyntaxError|SyntaxError.*broken\.tsx/s);
      expect(result.stdout).not.toContain("tsx-parse-failure");
      expect(repo.exists(".smithers/logs/tsx-parse-failure.log")).toBe(false);
      expectNoRunRow(repo, "tsx-parse-failure");
    },
    TIMEOUT_MS,
  );

  test(
    "workflow run -d preflights imported MDX parse errors",
    () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write(".smithers/prompts/broken.mdx", "# Broken\n\n{unterminated\n");
      repo.write(
        ".smithers/workflows/mdx-broken.tsx",
        [
          "/** @jsxImportSource smthrs */",
          'import BrokenPrompt from "../prompts/broken.mdx";',
          'import { createSmithers, Workflow, Task } from "smthrs";',
          'import { z } from "zod";',
          "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
          "export default smithers(() => (",
          '  <Workflow name="mdx-broken"><Task id="task" output={outputs.result}>',
          "    <BrokenPrompt />",
          "  </Task></Workflow>",
          "));",
          "",
        ].join("\n"),
      );

      const result = runSmithers(["workflow", "run", "mdx-broken", "-d", "--run-id", "mdx-parse-failure"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("broken.mdx");
      expect(result.stdout).not.toContain("mdx-parse-failure");
      expect(repo.exists(".smithers/logs/mdx-parse-failure.log")).toBe(false);
      expectNoRunRow(repo, "mdx-parse-failure");
    },
    TIMEOUT_MS,
  );

  test(
    "a valid detached launch returns only after its run row exists",
    () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write("workflow.tsx", validSlowWorkflow());

      const result = runSmithers(["up", "workflow.tsx", "-d", "--run-id", "admitted-run"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: TIMEOUT_MS,
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json?.runId).toBe("admitted-run");
      const db = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        expect(db.query("select run_id from _smithers_runs where run_id = ?").get("admitted-run")).toEqual({
          run_id: "admitted-run",
        });
      } finally {
        db.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a detached resume preflights the current workflow before spawning",
    () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write("workflow.tsx", validSlowWorkflow().replace("await Bun.sleep(1500);", "await Bun.sleep(1);"));
      const initial = runSmithers(["up", "workflow.tsx", "--run-id", "resume-preflight"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: TIMEOUT_MS,
      });
      expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

      repo.write("workflow.tsx", "export default `unterminated;\n");
      const resumed = runSmithers(["up", "workflow.tsx", "-d", "--resume", "--run-id", "resume-preflight"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });

      expect(resumed.exitCode).not.toBe(0);
      expect(resumed.stderr).toMatch(/workflow\.tsx:\d+/);
      expect(repo.exists(".smithers/logs/resume-preflight.log")).toBe(false);
      const db = new Database(repo.path("smithers.db"), { readonly: true });
      try {
        expect(db.query("select status from _smithers_runs where run_id = ?").get("resume-preflight")).toEqual({
          status: "finished",
        });
      } finally {
        db.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a child that dies after preflight but before admission fails with its log tail",
    () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      repo.write(
        "dies-in-child.tsx",
        [
          "/** @jsxImportSource smthrs */",
          'import { existsSync, writeFileSync } from "node:fs";',
          'import { createSmithers, Workflow, Task } from "smthrs";',
          'import { z } from "zod";',
          'const marker = ".detached-preflight-complete";',
          'if (existsSync(marker)) throw new Error("deliberate child pre-admission crash");',
          'writeFileSync(marker, "preflight completed\\n");',
          "const { smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });",
          "export default smithers(() => (",
          '  <Workflow name="pre-admission-death">',
          '    <Task id="task" output={outputs.result}>{{ ok: true }}</Task>',
          "  </Workflow>",
          "));",
          "",
        ].join("\n"),
      );

      const result = runSmithers(["up", "dies-in-child.tsx", "-d", "--run-id", "pre-admission-death"], {
        cwd: repo.dir,
        timeoutMs: TIMEOUT_MS,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("exited before admission");
      expect(result.stderr).toContain("Detached child log");
      expect(result.stderr).toContain("deliberate child pre-admission crash");
      expect(result.stdout).not.toContain("runId: pre-admission-death");
      expectNoRunRow(repo, "pre-admission-death");
    },
    TIMEOUT_MS,
  );
});
