// Real jj repository tests for the vcs package.
//
// These exercise the live `jj` binary against ephemeral repos so we can
// observe behavior that fake-bin tests cannot: dirty trees, untracked
// files, abandoned changes, large binaries, symlinks, and shell-meta
// names. If `jj` is not on PATH the entire suite is skipped at module
// load time.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import * as vcsEffects from "../src/jj.js";

const jjAvailable = (() => {
    try {
        const r = spawnSync("jj", ["--version"], { stdio: "ignore" });
        return r.status === 0;
    } catch {
        return false;
    }
})();

const describeIfJj = jjAvailable ? describe : describe.skip;

/**
 * @template A, E
 * @param {Effect.Effect<A, E, any>} effect
 */
function runVcs(effect) {
    return Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
}
const vcs = {
    runJj: (args, opts) => runVcs(vcsEffects.runJj(args, opts)),
    isJjRepo: (cwd) => runVcs(vcsEffects.isJjRepo(cwd)),
    workspaceAdd: (name, p, opts) => runVcs(vcsEffects.workspaceAdd(name, p, opts)),
    workspaceList: (cwd) => runVcs(vcsEffects.workspaceList(cwd)),
    workspaceClose: (name, opts) => runVcs(vcsEffects.workspaceClose(name, opts)),
    getJjPointer: (cwd) => runVcs(vcsEffects.getJjPointer(cwd)),
    revertToJjPointer: (pointer, cwd) => runVcs(vcsEffects.revertToJjPointer(pointer, cwd)),
};

/**
 * Initialize a fresh jj repo with a single committed file. Returns the repo
 * directory and a getter for the most recent change_id (`@-`).
 */
async function makeRepo(prefix = "jj-real-") {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const init = spawnSync("jj", ["git", "init"], { cwd: dir, encoding: "utf8" });
    if (init.status !== 0) {
        throw new Error(`jj git init failed: ${init.stderr}`);
    }
    return {
        dir,
        async cleanup() {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        },
        /** @param {string[]} args */
        jj(args) {
            return spawnSync("jj", args, { cwd: dir, encoding: "utf8" });
        },
        /** @returns {Promise<string>} change_id of `@` (current working copy) */
        async currentChangeId() {
            const r = spawnSync("jj", ["log", "-r", "@", "--no-graph", "--template", "change_id"], {
                cwd: dir, encoding: "utf8",
            });
            if (r.status !== 0) throw new Error(r.stderr);
            return r.stdout.trim();
        },
        /** @returns {Promise<string>} change_id of `@-` */
        async parentChangeId() {
            const r = spawnSync("jj", ["log", "-r", "@-", "--no-graph", "--template", "change_id"], {
                cwd: dir, encoding: "utf8",
            });
            if (r.status !== 0) throw new Error(r.stderr);
            return r.stdout.trim();
        },
    };
}

/**
 * @param {ReturnType<typeof makeRepo> extends Promise<infer R> ? R : never} repo
 */
async function commitFile(repo, name, contents, msg = "commit") {
    await fs.writeFile(path.join(repo.dir, name), contents);
    const r = repo.jj(["commit", "-m", msg]);
    if (r.status !== 0) throw new Error(`jj commit failed: ${r.stderr}`);
}

describeIfJj("revertToJjPointer with dirty working tree", () => {
    test("documents behavior: jj restore --from overwrites uncommitted changes (no rejection)", async () => {
        // generous timeout: jj init + commit + restore against a fresh
        // repo can spike past 1s on cold caches.
        const repo = await makeRepo();
        try {
            await commitFile(repo, "a.txt", "hello\n", "first");
            const target = await repo.parentChangeId();
            // Mutate the working copy without committing.
            await fs.writeFile(path.join(repo.dir, "a.txt"), "MODIFIED\n");
            const result = await vcs.revertToJjPointer(target, repo.dir);
            expect(result.success).toBe(true);
            const after = await fs.readFile(path.join(repo.dir, "a.txt"), "utf8");
            expect(after).toBe("hello\n");
        } finally {
            await repo.cleanup();
        }
    }, 30_000);

    test("untracked files in the working copy are absorbed by jj and removed by restore", async () => {
        const repo = await makeRepo();
        try {
            await commitFile(repo, "a.txt", "hello\n", "first");
            const target = await repo.parentChangeId();
            // Add an untracked file. jj automatically tracks it on the next snapshot.
            await fs.writeFile(path.join(repo.dir, "untracked.txt"), "new\n");
            const result = await vcs.revertToJjPointer(target, repo.dir);
            expect(result.success).toBe(true);
            // Restore copied state from the parent change which never had this file,
            // so the working copy should not contain it after the operation.
            const exists = await fs.stat(path.join(repo.dir, "untracked.txt")).then(() => true).catch(() => false);
            expect(exists).toBe(false);
        } finally {
            await repo.cleanup();
        }
    }, 30_000);
});

describeIfJj("revertToJjPointer with abandoned change", () => {
    test("returns success:false with a useful error string when target is abandoned", async () => {
        const repo = await makeRepo();
        try {
            await commitFile(repo, "a.txt", "hello\n", "first");
            const oldId = await repo.parentChangeId();
            // Move forward and abandon the original commit.
            const newRes = repo.jj(["new", "-m", "second"]);
            expect(newRes.status).toBe(0);
            const ab = repo.jj(["abandon", oldId]);
            expect(ab.status).toBe(0);
            const result = await vcs.revertToJjPointer(oldId, repo.dir);
            expect(result.success).toBe(false);
            // The error string should mention either "doesn't exist" or the id.
            expect(typeof result.error).toBe("string");
            expect((result.error ?? "").length).toBeGreaterThan(0);
        } finally {
            await repo.cleanup();
        }
    }, 30_000);
});

describeIfJj("shell-metacharacter safety in args (no injection)", () => {
    test("workspace names with /, -, $, ;, spaces, Unicode are forwarded as opaque argv", async () => {
        const repo = await makeRepo();
        try {
            await commitFile(repo, "seed.txt", "x\n", "seed");
            // We can't actually create workspaces with all of these names (jj
            // imposes its own validation), but we can verify our wrapper does
            // not invoke a shell, by checking the resulting error message
            // never contains evidence of shell expansion (e.g. exit codes
            // 127 from a shell trying to run `;rm`).
            const evilNames = [
                "name with spaces",
                "name;rm -rf /tmp/should-not-exist-xyz",
                "name$(echo PWNED)",
                "name`echo PWNED`",
                "name|cat",
                "name>/tmp/should-not-exist-xyz2",
                "name-with-dashes/and/slashes",
                "ñame-unicode-✨",
            ];
            for (const name of evilNames) {
                // Run any operation that takes the name as an argv element.
                // jj's exit code or success status doesn't matter; we only
                // care that the shell never expanded the metacharacters.
                await vcs.workspaceClose(name, { cwd: repo.dir });
                // No shell side-effects: probe paths must NOT exist.
                const probe1 = await fs.stat("/tmp/should-not-exist-xyz").then(() => true).catch(() => false);
                const probe2 = await fs.stat("/tmp/should-not-exist-xyz2").then(() => true).catch(() => false);
                expect(probe1).toBe(false);
                expect(probe2).toBe(false);
                // Also exercise runJj directly with the value embedded as an
                // arg to ensure the same guarantee for the public helper.
                await vcs.runJj(["log", "-r", "@", "--no-graph", "--template", `'${name}'`], { cwd: repo.dir });
                const probe1b = await fs.stat("/tmp/should-not-exist-xyz").then(() => true).catch(() => false);
                expect(probe1b).toBe(false);
            }
        } finally {
            await repo.cleanup();
        }
    }, 30_000);
});

describeIfJj("large binary files in workspace", () => {
    test("getJjPointer / isJjRepo work with a multi-MB binary committed", async () => {
        const repo = await makeRepo();
        try {
            // 4 MB random buffer
            const buf = new Uint8Array(4 * 1024 * 1024);
            for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 1103515245 + 12345) & 0xff;
            await fs.writeFile(path.join(repo.dir, "blob.bin"), buf);
            const r = repo.jj(["commit", "-m", "blob"]);
            expect(r.status).toBe(0);
            const isRepo = await vcs.isJjRepo(repo.dir);
            expect(isRepo).toBe(true);
            const ptr = await vcs.getJjPointer(repo.dir);
            expect(typeof ptr).toBe("string");
            expect((ptr ?? "").length).toBeGreaterThan(0);
        } finally {
            await repo.cleanup();
        }
    }, 30_000);
});

describeIfJj("symlinks in workspace", () => {
    test("jj tracks symlinks; isJjRepo + getJjPointer succeed and restore preserves link", async () => {
        const repo = await makeRepo();
        try {
            await fs.writeFile(path.join(repo.dir, "target.txt"), "hello\n");
            await fs.symlink("target.txt", path.join(repo.dir, "link.txt"));
            const r = repo.jj(["commit", "-m", "with symlink"]);
            expect(r.status).toBe(0);
            const ptr = await vcs.getJjPointer(repo.dir);
            expect(typeof ptr).toBe("string");
            // A symlink should still be a symlink after we restore from the parent change.
            const parent = await repo.parentChangeId();
            const result = await vcs.revertToJjPointer(parent, repo.dir);
            expect(result.success).toBe(true);
            const stat = await fs.lstat(path.join(repo.dir, "link.txt"));
            expect(stat.isSymbolicLink()).toBe(true);
        } finally {
            await repo.cleanup();
        }
    }, 30_000);
});
