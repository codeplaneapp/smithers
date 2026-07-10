import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __engineInternals as I } from "../src/engine.js";

/**
 * Regression coverage for issue #935: N parallel <Worktree> lanes all run
 * `git worktree add` / `jj workspace add` against the repo's shared `.git`
 * state, and without serialization they deterministically race each other off
 * the index lock (38 of 50 lanes died in one production run). ensureWorktree
 * now serializes creation per VCS root, so EVERY concurrent creation must
 * succeed. Real git repo, no mocks.
 */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
function runGit(cwd, args) {
    return new Promise((res) => {
        const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (err) => res({ code: 127, stdout: "", stderr: err.message }));
        child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
    const res = await runGit(cwd, args);
    if (res.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${res.code}): ${res.stderr}`);
    }
    return res;
}

describe("ensureWorktree under parallel creation", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-worktree-race-"));

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("16 concurrent creations on one repo all succeed", async () => {
        const repo = join(root, "repo");
        await git(root, ["init", "-b", "main", "repo"]);
        await git(repo, ["config", "user.email", "test@smithers.sh"]);
        await git(repo, ["config", "user.name", "smithers-test"]);
        writeFileSync(join(repo, "file.txt"), "hello\n");
        await git(repo, ["add", "file.txt"]);
        await git(repo, ["commit", "-m", "init"]);

        const lanes = Array.from({ length: 16 }, (_, index) => index);
        const results = await Promise.allSettled(lanes.map((index) =>
            I.ensureWorktree(
                repo,
                join(root, "worktrees", `lane-${index}`),
                `smithers/test/lane-${index}`,
                "main",
            )));

        const failures = results
            .map((result, index) => ({ result, index }))
            .filter(({ result }) => result.status === "rejected")
            .map(({ result, index }) => `lane-${index}: ${/** @type {PromiseRejectedResult} */ (result).reason}`);
        expect(failures).toEqual([]);
        for (const index of lanes) {
            expect(existsSync(join(root, "worktrees", `lane-${index}`, "file.txt"))).toBe(true);
        }
    }, 120_000);
});
