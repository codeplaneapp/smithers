/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Task, Workflow, Worktree, createSmithers, runWorkflow, } from "smithers-orchestrator";
import { z } from "zod";
import { Effect } from "effect";
const tempRoots = [];
const WORKTREE_RUNTIME_TIMEOUT_MS = 15_000;
afterEach(async () => {
    for (const dir of tempRoots.splice(0)) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
});
function hasGit() {
    const result = spawnSync("git", ["--version"], { encoding: "utf8" });
    return result.status === 0;
}
/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runGit(cwd, args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`);
    }
}
async function createGitRepoWithoutOrigin() {
    const root = await mkdtemp(join(tmpdir(), "smithers-worktree-runtime-"));
    tempRoots.push(root);
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "smithers-test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Smithers Test"]);
    await writeFile(join(repoDir, "README.md"), "test\n", "utf8");
    runGit(repoDir, ["add", "README.md"]);
    runGit(repoDir, ["commit", "-m", "init"]);
    return { root, repoDir };
}
describe("Worktree runtime", () => {
    test("falls back to HEAD when origin/main is unavailable", async () => {
        if (!hasGit())
            return;
        const { root, repoDir } = await createGitRepoWithoutOrigin();
        const linkedPath = resolve(repoDir, "..", "linked-head");
        const api = createSmithers({ outputA: z.object({ value: z.number() }) }, { dbPath: join(root, "db.sqlite") });
        const workflow = api.smithers((_ctx) => (<Workflow name="head-fallback">
          <Worktree id="wt" path="../linked-head">
            <Task id="task1" output={api.outputs.outputA}>
              {{ value: 1 }}
            </Task>
          </Worktree>
        </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: repoDir, keepWorktrees: true }));
        try {
            expect(result.status).toBe("finished");
            expect(existsSync(linkedPath)).toBe(true);
        }
        finally {
            try {
                api.db.$client?.close?.();
            }
            catch { }
        }
    }, WORKTREE_RUNTIME_TIMEOUT_MS);
    test("recreates a deleted worktree path on later runs", async () => {
        if (!hasGit())
            return;
        const { root, repoDir } = await createGitRepoWithoutOrigin();
        const linkedPath = resolve(repoDir, "..", "linked-recreate");
        const api = createSmithers({ outputA: z.object({ value: z.number() }) }, { dbPath: join(root, "db.sqlite") });
        const workflow = api.smithers((_ctx) => (<Workflow name="recreate-worktree">
          <Worktree id="wt" path="../linked-recreate">
            <Task id="task1" output={api.outputs.outputA}>
              {{ value: 1 }}
            </Task>
          </Worktree>
        </Workflow>));
        try {
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: repoDir, keepWorktrees: true }));
            expect(first.status).toBe("finished");
            expect(existsSync(linkedPath)).toBe(true);
            await rm(linkedPath, { recursive: true, force: true });
            runGit(repoDir, ["worktree", "prune"]);
            expect(existsSync(linkedPath)).toBe(false);
            const second = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: repoDir, keepWorktrees: true }));
            expect(second.status).toBe("finished");
            expect(existsSync(linkedPath)).toBe(true);
        }
        finally {
            try {
                api.db.$client?.close?.();
            }
            catch { }
        }
    }, WORKTREE_RUNTIME_TIMEOUT_MS);
    test("injects the worktree isolation notice into agent prompts", async () => {
        if (!hasGit())
            return;
        const { root, repoDir } = await createGitRepoWithoutOrigin();
        const api = createSmithers({ outputA: z.object({ value: z.number() }) }, { dbPath: join(root, "db.sqlite") });
        /** @type {string | null} */
        let seenPrompt = null;
        const agent = {
            id: "prompt-capture",
            tools: {},
            /** @param {{ prompt?: string }} args */
            generate: async (args) => {
                seenPrompt = args.prompt ?? null;
                return { output: { value: 1 } };
            },
        };
        const workflow = api.smithers((_ctx) => (<Workflow name="isolation-notice">
          <Worktree id="wt" path="../linked-notice">
            <Task id="task1" agent={agent} output={api.outputs.outputA}>
              Do the work.
            </Task>
          </Worktree>
        </Workflow>));
        try {
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir: repoDir }));
            expect(result.status).toBe("finished");
            expect(seenPrompt).not.toBeNull();
            expect(seenPrompt).toContain("[smithers worktree isolation]");
            expect(seenPrompt).toContain(`the parent checkout at ${repoDir}`);
            expect(seenPrompt).toContain("NEVER symlink node_modules");
            expect(seenPrompt).toContain("Do the work.");
            // The notice names the parent checkout, and the task text follows it.
            expect(seenPrompt?.indexOf("[smithers worktree isolation]")).toBeLessThan(seenPrompt?.indexOf("Do the work.") ?? -1);
        }
        finally {
            try {
                api.db.$client?.close?.();
            }
            catch { }
        }
    }, WORKTREE_RUNTIME_TIMEOUT_MS);
});
