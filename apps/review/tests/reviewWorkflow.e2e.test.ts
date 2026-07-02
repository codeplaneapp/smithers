import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { runWorkflow } from "@smithers-orchestrator/engine";
import { Effect } from "effect";
import { createReviewWorkflow } from "../src/workflow/createReviewWorkflow";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "review-e2e-"));
  tempDirs.push(dir);
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  write(join(dir, "src/app.ts"), "export const value = 1;\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "initial"], dir);
  return dir;
}

describe("smithers review workflow (agentless e2e through the real engine)", () => {
  test(
    "writes a walkthrough HTML covering every changed file; review reports skipped",
    async () => {
      const repo = tempRepo();
      write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
      write(join(repo, "src/util.ts"), "export const util = () => 42;\n");
      write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");
      write(join(repo, "README.md"), "# Demo\n");

      const work = mkdtempSync(join(tmpdir(), "review-work-"));
      tempDirs.push(work);
      const dbPath = join(work, "review.db");
      const outPath = join(work, "walkthrough.html");

      // runReview/narrate stay true: with no agents configured the workflow
      // must downgrade review to "skipped" and narration to the fallback
      // story on its own.
      const { workflow, db, tables } = createReviewWorkflow({ dbPath, reviewAgents: [], narratorAgents: [] });
      const runId = `review-e2e-${Date.now()}`;
      const result = (await Effect.runPromise(
        runWorkflow(workflow as never, {
          input: { repo, out: outPath, runReview: true, narrate: true },
          runId,
          allowNetwork: true,
        }) as never,
      )) as { status: string };

      expect(result.status).not.toBe("failed");
      expect(existsSync(outPath)).toBe(true);

      const html = readFileSync(outPath, "utf8");
      for (const path of ["src/app.ts", "src/util.ts", "src/app.test.ts", "README.md"]) {
        expect(html).toContain(path);
      }
      expect(html).toContain("The main change: src");
      expect(html).toContain('data-line-type="change-addition"');
      expect(html).toContain("--diffs-token-light");

      const rows = (await loadOutputs(db as never, tables as never, runId)) as Record<
        string,
        Record<string, unknown>[]
      >;
      const walkthrough = rows.walkthrough?.at(-1);
      expect(walkthrough).toBeDefined();
      expect(String(walkthrough!.path)).toBe(outPath);
      expect(Number(walkthrough!.files)).toBe(4);
      expect(Number(walkthrough!.findings)).toBe(0);
      expect(Number(walkthrough!.chapters)).toBeGreaterThan(0);

      const review = rows.review?.at(-1);
      expect(review).toBeDefined();
      expect(String(review!.status)).toBe("skipped");
    },
    120_000,
  );
});
