/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";
import { z } from "zod/v4";

setDefaultTimeout(60_000);

type Task = {
  nodeId: string;
  needsApproval?: boolean;
  outputSchema?: { safeParse(value: unknown): { success: boolean } };
  prompt?: unknown;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Task[] };

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflows, file);
const load = async (file: string) => (await import(pathFor(file))).default;
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(file), { workflowPath: pathFor(file), input, outputs })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const staged = (id: string, value: Record<string, unknown>) => [{ nodeId: id, ...value }];
const approval = {
  approved: true,
  note: "ship it",
  decidedBy: "workflow-test",
  decidedAt: "2026-07-14T12:00:00.000Z",
};
const implemented = { summary: "implemented", filesChanged: [] as string[] };

async function isolated<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = process.cwd();
  const path = process.env.PATH;
  const state = process.env.SMITHERS_TEST_PNPM_STATE;
  const failures = process.env.SMITHERS_TEST_FAIL_TYPECHECKS;
  try {
    process.chdir(root);
    return await body(root);
  } finally {
    process.chdir(cwd);
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (state === undefined) delete process.env.SMITHERS_TEST_PNPM_STATE;
    else process.env.SMITHERS_TEST_PNPM_STATE = state;
    if (failures === undefined) delete process.env.SMITHERS_TEST_FAIL_TYPECHECKS;
    else process.env.SMITHERS_TEST_FAIL_TYPECHECKS = failures;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

function installFakePnpm(root: string, failingTypechecks: number): void {
  const bin = join(root, "bin");
  const state = join(root, "pnpm-state");
  mkdirSync(bin, { recursive: true });
  const source = [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'if (args.at(-1) === "typecheck") {',
    "  let count = 0;",
    '  try { count = Number(fs.readFileSync(process.env.SMITHERS_TEST_PNPM_STATE, "utf8")); } catch {}',
    "  fs.writeFileSync(process.env.SMITHERS_TEST_PNPM_STATE, String(count + 1));",
    "  process.stdout.write(`typecheck ${count + 1}\\n`);",
    '  process.exit(count < Number(process.env.SMITHERS_TEST_FAIL_TYPECHECKS || "0") ? 1 : 0);',
    "}",
    'process.stdout.write("tests green\\n");',
  ].join("\n");
  if (process.platform === "win32") {
    writeFileSync(join(bin, "pnpm.js"), source);
    writeFileSync(join(bin, "pnpm.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0pnpm.js" %*\r\n`);
  } else {
    const executable = join(bin, "pnpm");
    writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
    chmodSync(executable, 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.SMITHERS_TEST_PNPM_STATE = state;
  process.env.SMITHERS_TEST_FAIL_TYPECHECKS = String(failingTypechecks);
}

const baseMocks = {
  "implement-worker": implemented,
  "implement-action": implemented,
  "fix-round": ({ iteration }: { iteration: number }) => ({ summary: `fixed iteration ${iteration}` }),
};

describe("review-cloud-ship behavioral contract", () => {
  test("validates defaults and the supported fix-round bounds", async () => {
    const schema = (await import(pathFor("review-cloud-ship.tsx"))).inputSchema as z.ZodObject<any>;
    expect(schema.parse({})).toMatchObject({ maxFixRounds: 3, dogfood: true });
    expect(schema.parse({ maxFixRounds: 0 }).maxFixRounds).toBe(0);
    expect(schema.parse({ maxFixRounds: 10 }).maxFixRounds).toBe(10);
    expect(schema.safeParse({ maxFixRounds: -1 }).success).toBe(false);
    expect(schema.safeParse({ maxFixRounds: 11 }).success).toBe(false);
  });

  test("simulates a real red -> fix -> green verification cycle", async () =>
    isolated("smithers-review-cloud-green-", async (root) => {
      installFakePnpm(root, 1);
      const sim = simulate(await load("review-cloud-ship.tsx"), {
        input: { maxFixRounds: 2, dogfood: false },
        workflowPath: pathFor("review-cloud-ship.tsx"),
        rootDir: root,
        mocks: baseMocks,
      });
      await sim.run();
      expect(sim.status).toBe("waiting-approval");
      expect(sim.executed).toEqual(["implement-worker", "implement-action", "verify", "fix-round", "verify"]);
      expect(sim.task("verify").outputs).toHaveLength(2);
      expect(sim.task("fix-round").outputs).toHaveLength(1);
      expect(sim.task("fix-round").prompts[0]).toContain("typecheck 1");
      expect(sim.unusedMocks).toEqual([]);
    }));

  test("fails persistent red after exactly three verifies and two fixes", async () =>
    isolated("smithers-review-cloud-red-", async (root) => {
      installFakePnpm(root, 99);
      const sim = simulate(await load("review-cloud-ship.tsx"), {
        input: { maxFixRounds: 2, dogfood: false },
        workflowPath: pathFor("review-cloud-ship.tsx"),
        rootDir: root,
        mocks: baseMocks,
      });
      await expect(sim.run()).rejects.toThrow();
      expect(sim.status).toBe("failed");
      expect(sim.task("verify").outputs).toHaveLength(3);
      expect(sim.task("fix-round").outputs).toHaveLength(2);
      expect(sim.executed).toEqual([
        "implement-worker",
        "implement-action",
        "verify",
        "fix-round",
        "verify",
        "fix-round",
        "verify",
      ]);
      expect(sim.executed).not.toContain("approve-deploy");
      const exhausted = await render(
        "review-cloud-ship.tsx",
        { maxFixRounds: 2, dogfood: false },
        {
          implementWorker: staged("implement-worker", implemented),
          implementAction: staged("implement-action", implemented),
          verify: [
            { nodeId: "verify", pass: false, log: "red 1" },
            { nodeId: "verify", pass: false, log: "red 2" },
            { nodeId: "verify", pass: false, log: "red 3" },
          ],
          fixRound: [
            { nodeId: "fix-round", summary: "fix 1" },
            { nodeId: "fix-round", summary: "fix 2" },
          ],
        },
      );
      expect(exhausted.tasks.some(({ nodeId }) => nodeId === "approve-deploy")).toBe(false);
    }));

  test("keeps every approved deployment step causally gated and reports dogfood disabled", async () => {
    const input = { maxFixRounds: 0, dogfood: false };
    const common = {
      implementWorker: staged("implement-worker", implemented),
      implementAction: staged("implement-action", implemented),
      verify: staged("verify", { pass: true, log: "green" }),
      deployApproval: staged("approve-deploy", approval),
    };
    const approved = await render("review-cloud-ship.tsx", input, common);
    expect(task(approved, "approve-deploy").needsApproval).toBe(true);
    expect(task(approved, "approve-deploy").outputSchema?.safeParse(approval).success).toBe(true);
    expect(task(approved, "push-main").nodeId).toBe("push-main");

    const pushFailed = await render("review-cloud-ship.tsx", input, {
      ...common,
      pushMain: staged("push-main", { ok: false, sha: "", log: "push failed" }),
    });
    expect(task(pushFailed, "deploy").skipIf).toBe(true);
    const pushed = {
      ...common,
      pushMain: staged("push-main", { ok: true, sha: "abc123", log: "pushed" }),
    };
    const pushPassed = await render("review-cloud-ship.tsx", input, pushed);
    expect(task(pushPassed, "deploy").nodeId).toBe("deploy");
    expect(task(pushPassed, "deploy").skipIf).toBe(false);

    const deployFailed = await render("review-cloud-ship.tsx", input, {
      ...pushed,
      deploy: staged("deploy", { ok: false, log: "deploy failed" }),
    });
    expect(task(deployFailed, "register-dogfood").skipIf).toBe(true);
    const deployed = {
      ...pushed,
      deploy: staged("deploy", { ok: true, log: "deployed" }),
    };
    const deployPassed = await render("review-cloud-ship.tsx", input, deployed);
    expect(task(deployPassed, "register-dogfood").nodeId).toBe("register-dogfood");
    expect(task(deployPassed, "register-dogfood").skipIf).toBe(false);

    const registrationFailed = await render("review-cloud-ship.tsx", input, {
      ...deployed,
      registerDogfood: staged("register-dogfood", { ok: false, detail: "registration failed" }),
    });
    expect(task(registrationFailed, "smoke").skipIf).toBe(true);
    const registered = {
      ...deployed,
      registerDogfood: staged("register-dogfood", { ok: true, detail: "registered" }),
    };
    const registrationPassed = await render("review-cloud-ship.tsx", input, registered);
    expect(task(registrationPassed, "smoke").nodeId).toBe("smoke");
    expect(task(registrationPassed, "smoke").skipIf).toBe(false);

    const smokeFailed = await render("review-cloud-ship.tsx", input, {
      ...registered,
      smoke: staged("smoke", { ok: false, detail: "smoke failed" }),
    });
    expect(task(smokeFailed, "dogfood-pr").skipIf).toBe(true);
    const complete = await render("review-cloud-ship.tsx", input, {
      ...registered,
      smoke: staged("smoke", { ok: true, detail: "smoke green" }),
    });
    expect(task(complete, "dogfood-pr").skipIf).toBe(true);
    expect(task(complete, "report").nodeId).toBe("report");
    await expect(runTask(task(complete, "report") as never)).resolves.toEqual(
      expect.objectContaining({
        summary: expect.stringContaining("dogfood: skipped"),
      }),
    );
  });

  test("uses a run-unique OS temp worktree in the dogfood prompt", async () => {
    const frame = await render(
      "review-cloud-ship.tsx",
      { maxFixRounds: 0, dogfood: true },
      {
        implementWorker: staged("implement-worker", implemented),
        implementAction: staged("implement-action", implemented),
        verify: staged("verify", { pass: true, log: "green" }),
        deployApproval: staged("approve-deploy", approval),
        pushMain: staged("push-main", { ok: true, sha: "abc123", log: "pushed" }),
        deploy: staged("deploy", { ok: true, log: "deployed" }),
        registerDogfood: staged("register-dogfood", { ok: true, detail: "registered" }),
        smoke: staged("smoke", { ok: true, detail: "green" }),
      },
    );
    const text = renderPrompt(task(frame, "dogfood-pr").prompt);
    const uniqueWorktreePrefix = join(tmpdir(), "review-cloud-dogfood-");
    expect(text).toContain(uniqueWorktreePrefix);
    // On Linux tmpdir() IS /tmp, so the run-unique path itself starts with the
    // fixed literal; strip every run-unique occurrence first, then assert no
    // bare fixed-path worktree leaked through un-substituted.
    expect(text.split(uniqueWorktreePrefix).join("")).not.toContain("/tmp/review-cloud-dogfood");
  });

  test("push-main atomically commits both the review app and its specification", async () =>
    isolated("smithers-review-cloud-git-", async (root) => {
      const work = join(root, "work");
      const origin = join(root, "origin.git");
      mkdirSync(join(work, "apps", "review"), { recursive: true });
      mkdirSync(join(work, ".smithers", "specs"), { recursive: true });
      execFileSync("git", ["init", "--bare", origin]);
      execFileSync("git", ["init", "-b", "main"], { cwd: work });
      execFileSync("git", ["config", "user.email", "workflow-test@example.com"], { cwd: work });
      execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: work });
      writeFileSync(join(work, "apps", "review", "worker.ts"), "export const version = 1;\n");
      writeFileSync(join(work, ".smithers", "specs", "smithers-review-cloud.md"), "# Review cloud v1\n");
      execFileSync("git", ["add", "apps/review", ".smithers/specs/smithers-review-cloud.md"], { cwd: work });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: work });
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: work });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: work });
      writeFileSync(join(work, "apps", "review", "worker.ts"), "export const version = 2;\n");
      writeFileSync(join(work, ".smithers", "specs", "smithers-review-cloud.md"), "# Review cloud v2\n");
      process.chdir(work);

      const frame = await render(
        "review-cloud-ship.tsx",
        { maxFixRounds: 0, dogfood: false },
        {
          implementWorker: staged("implement-worker", implemented),
          implementAction: staged("implement-action", implemented),
          verify: staged("verify", { pass: true, log: "green" }),
          deployApproval: staged("approve-deploy", approval),
        },
      );
      await expect(runTask(task(frame, "push-main") as never)).resolves.toMatchObject({ ok: true });
      const changed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
        cwd: work,
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .sort();
      expect(changed).toEqual([".smithers/specs/smithers-review-cloud.md", "apps/review/worker.ts"]);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: work, encoding: "utf8" })).toBe("");
      const local = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
      const remote = execFileSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim();
      expect(remote).toBe(local);
    }));
});
