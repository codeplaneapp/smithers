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
import { Effect, HashMap, Logger, Option } from "effect";
import * as BunContext from "@effect/platform-bun/BunServices";
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

/**
 * Run a vcs effect while capturing every emitted log record so a test can
 * assert on structured warnings (e.g. the durability-gap reason).
 *
 * @template A
 * @param {Effect.Effect<A, any, any>} effect
 * @returns {Promise<{ value: A, records: Array<{ level: string, message: string, annotations: HashMap.HashMap<string, unknown> }> }>}
 */
function runVcsCapturingLogs(effect) {
  /** @type {Array<{ level: string, message: string, annotations: HashMap.HashMap<string, unknown> }>} */
  const records = [];
  const testLogger = Logger.make((opts) => {
    records.push({
      level: opts.logLevel.label,
      message: Array.isArray(opts.message) ? opts.message.join(" ") : String(opts.message),
      annotations: opts.annotations,
    });
  });
  return Effect.runPromise(
    effect.pipe(Effect.provide(BunContext.layer), Effect.provide(Logger.replace(Logger.defaultLogger, testLogger))),
  ).then((value) => ({ value, records }));
}
const vcs = {
  runJj: (args, opts) => runVcs(vcsEffects.runJj(args, opts)),
  isJjRepo: (cwd) => runVcs(vcsEffects.isJjRepo(cwd)),
  workspaceAdd: (name, p, opts) => runVcs(vcsEffects.workspaceAdd(name, p, opts)),
  workspaceList: (cwd) => runVcs(vcsEffects.workspaceList(cwd)),
  workspaceClose: (name, opts) => runVcs(vcsEffects.workspaceClose(name, opts)),
  getJjPointer: (cwd) => runVcs(vcsEffects.getJjPointer(cwd)),
  revertToJjPointer: (pointer, cwd) => runVcs(vcsEffects.revertToJjPointer(pointer, cwd)),
  captureWorkspaceSnapshot: (cwd) => runVcs(vcsEffects.captureWorkspaceSnapshot(cwd)),
};

/**
 * Initialize a fresh jj repo with a single committed file. Returns the repo
 * directory and getters for immutable commit ids plus the current change id.
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
        cwd: dir,
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    },
    /** @returns {Promise<string>} commit_id of `@-` */
    async parentCommitId() {
      const r = spawnSync("jj", ["log", "-r", "@-", "--no-graph", "--template", "commit_id"], {
        cwd: dir,
        encoding: "utf8",
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
      const target = await repo.parentCommitId();
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
      const target = await repo.parentCommitId();
      // Add an untracked file. jj automatically tracks it on the next snapshot.
      await fs.writeFile(path.join(repo.dir, "untracked.txt"), "new\n");
      const result = await vcs.revertToJjPointer(target, repo.dir);
      expect(result.success).toBe(true);
      // Restore copied state from the parent change which never had this file,
      // so the working copy should not contain it after the operation.
      const exists = await fs
        .stat(path.join(repo.dir, "untracked.txt"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

describeIfJj("revertToJjPointer with a missing immutable commit", () => {
  test("returns success:false with a useful error string when the target does not exist", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "hello\n", "first");
      const missingCommitId = "f".repeat(40);
      const result = await vcs.revertToJjPointer(missingCommitId, repo.dir);
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe("string");
      expect((result.error ?? "").length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

describeIfJj("workspaceAdd / workspaceList / workspaceClose against real jj", () => {
  test("add creates a workspace, list parses it, close forgets it", async () => {
    const repo = await makeRepo();
    // Sibling dir for the extra workspace so we don't nest it inside the repo.
    const wsPath = path.join(path.dirname(repo.dir), `ws-extra-${process.pid}-${Date.now()}`);
    try {
      await commitFile(repo, "a.txt", "hello\n", "seed");

      // Baseline: a fresh repo has exactly the "default" workspace.
      const before = await vcs.workspaceList(repo.dir);
      expect(Array.isArray(before)).toBe(true);
      expect(before.some((w) => w.name === "default")).toBe(true);
      expect(before.find((w) => w.name === "default")?.selected).toBe(true);
      expect(before.some((w) => w.name === "extra")).toBe(false);

      // Add a second workspace and confirm jj actually materialized it.
      const added = await vcs.workspaceAdd("extra", wsPath, { cwd: repo.dir });
      expect(added.success).toBe(true);
      const wsExists = await fs
        .stat(wsPath)
        .then((s) => s.isDirectory())
        .catch(() => false);
      expect(wsExists).toBe(true);

      // List now parses real jj output and must include both workspaces.
      const after = await vcs.workspaceList(repo.dir);
      const names = after.map((w) => w.name).sort();
      expect(names).toContain("default");
      expect(names).toContain("extra");
      expect(after.find((w) => w.name === "default")?.selected).toBe(true);
      expect(after.find((w) => w.name === "extra")?.selected).toBe(false);

      // Close (forget) the workspace; jj drops it from its metadata.
      const closed = await vcs.workspaceClose("extra", { cwd: repo.dir });
      expect(closed.success).toBe(true);
      const afterClose = await vcs.workspaceList(repo.dir);
      expect(afterClose.some((w) => w.name === "extra")).toBe(false);
    } finally {
      await repo.cleanup();
      await fs.rm(wsPath, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("close of a non-existent workspace is a no-op success (jj forget is idempotent)", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "hello\n", "seed");
      const result = await vcs.workspaceClose("does-not-exist", { cwd: repo.dir });
      // `jj workspace forget <missing>` exits 0 with a warning, so our
      // wrapper reports success rather than a spurious failure.
      expect(result.success).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("add fails with a useful error when the target dir cannot be created", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "hello\n", "seed");
      // Make the would-be parent of the workspace path a regular file so
      // neither our pre-create mkdir nor jj can place a workspace there.
      const blocker = path.join(repo.dir, "blocker");
      await fs.writeFile(blocker, "not a dir\n");
      const badPath = path.join(blocker, "sub");
      const result = await vcs.workspaceAdd("bad", badPath, { cwd: repo.dir });
      expect(result.success).toBe(false);
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
        const probe1 = await fs
          .stat("/tmp/should-not-exist-xyz")
          .then(() => true)
          .catch(() => false);
        const probe2 = await fs
          .stat("/tmp/should-not-exist-xyz2")
          .then(() => true)
          .catch(() => false);
        expect(probe1).toBe(false);
        expect(probe2).toBe(false);
        // Also exercise runJj directly with the value embedded as an
        // arg to ensure the same guarantee for the public helper.
        await vcs.runJj(["log", "-r", "@", "--no-graph", "--template", `'${name}'`], { cwd: repo.dir });
        const probe1b = await fs
          .stat("/tmp/should-not-exist-xyz")
          .then(() => true)
          .catch(() => false);
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
      const parent = await repo.parentCommitId();
      const result = await vcs.revertToJjPointer(parent, repo.dir);
      expect(result.success).toBe(true);
      const stat = await fs.lstat(path.join(repo.dir, "link.txt"));
      expect(stat.isSymbolicLink()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

describeIfJj("captureWorkspaceSnapshot against real jj", () => {
  test("captures commit/change/operation ids; commit_id advances per write while change_id is stable", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "hello\n", "seed");
      await fs.writeFile(path.join(repo.dir, "work.txt"), "v1\n");
      const s1 = await vcs.captureWorkspaceSnapshot(repo.dir);
      expect(s1).not.toBeNull();
      expect(s1.commitId.length).toBeGreaterThan(0);
      expect(s1.changeId.length).toBeGreaterThan(0);
      expect(s1.operationId.length).toBeGreaterThan(0);

      // A second write to the same working copy: change_id is stable,
      // commit_id (the per-state key) advances, and the operation differs.
      await fs.writeFile(path.join(repo.dir, "work.txt"), "v2\n");
      const s2 = await vcs.captureWorkspaceSnapshot(repo.dir);
      expect(s2).not.toBeNull();
      expect(s2.changeId).toBe(s1.changeId);
      expect(s2.commitId).not.toBe(s1.commitId);
      expect(s2.operationId).not.toBe(s1.operationId);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("re-capturing an unchanged working copy yields the same commit_id (dedup key is stable)", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "hello\n", "seed");
      await fs.writeFile(path.join(repo.dir, "work.txt"), "v1\n");
      const s1 = await vcs.captureWorkspaceSnapshot(repo.dir);
      const s2 = await vcs.captureWorkspaceSnapshot(repo.dir);
      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s2.commitId).toBe(s1.commitId);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("returns null in a non-jj directory (durability gap, never throws)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "not-jj-"));
    try {
      const snap = await vcs.captureWorkspaceSnapshot(dir);
      expect(snap).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  test("logs a structured durability-gap warning with the jj reason when the snapshot fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "not-jj-"));
    try {
      const { value, records } = await runVcsCapturingLogs(vcsEffects.captureWorkspaceSnapshot(dir));
      // Contract preserved: callers still see null on a gap.
      expect(value).toBeNull();
      // But the reason is no longer swallowed: a WARN records why.
      const gap = records.find((r) => r.level === "WARN" && r.message.includes("durability gap"));
      expect(gap).toBeDefined();
      // The reason must be a concrete, non-empty attribution (jj's error).
      const reason = Option.getOrNull(HashMap.get(gap.annotations, "reason"));
      expect(typeof reason).toBe("string");
      expect((reason ?? "").length).toBeGreaterThan(0);
      // And the failing step is annotated so the gap is attributable.
      const step = Option.getOrNull(HashMap.get(gap.annotations, "snapshotStep"));
      expect(step).toBe("log");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});

// The producer/consumer durability contract behind crash recovery: the engine
// records a commitId via captureWorkspaceSnapshot, and on revert/replay feeds
// that exact commitId back into revertToJjPointer. This pair is what guarantees
// "your files come back" after a crash, so it must be exercised end-to-end with
// a *real* commitId — not a hand-picked change_id.
describeIfJj("captureWorkspaceSnapshot -> revertToJjPointer round-trip (real commitId)", () => {
  test("restores file content to the captured working-copy state", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "seed\n", "seed");
      // Write the state we want to be able to come back to, then capture it.
      await fs.writeFile(path.join(repo.dir, "work.txt"), "checkpoint-v1\n");
      const snapshot = await vcs.captureWorkspaceSnapshot(repo.dir);
      expect(snapshot).not.toBeNull();
      expect(typeof snapshot.commitId).toBe("string");
      expect(snapshot.commitId.length).toBeGreaterThan(0);

      // Mutate the working copy away from the captured state.
      await fs.writeFile(path.join(repo.dir, "work.txt"), "drifted-v2\n");
      expect(await fs.readFile(path.join(repo.dir, "work.txt"), "utf8")).toBe("drifted-v2\n");

      // Restore using the CAPTURED commitId (the durable handle), not a
      // change_id we read separately.
      const result = await vcs.revertToJjPointer(snapshot.commitId, repo.dir);
      expect(result.success).toBe(true);

      // The working copy must match the captured state byte-for-byte.
      expect(await fs.readFile(path.join(repo.dir, "work.txt"), "utf8")).toBe("checkpoint-v1\n");
      expect(await fs.readFile(path.join(repo.dir, "a.txt"), "utf8")).toBe("seed\n");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("restore from the captured commitId removes files added after the capture", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "seed\n", "seed");
      await fs.writeFile(path.join(repo.dir, "kept.txt"), "kept\n");
      const snapshot = await vcs.captureWorkspaceSnapshot(repo.dir);
      expect(snapshot).not.toBeNull();

      // Add a brand-new file after the checkpoint was captured.
      await fs.writeFile(path.join(repo.dir, "added-later.txt"), "should disappear\n");
      await fs.writeFile(path.join(repo.dir, "kept.txt"), "kept-but-edited\n");

      const result = await vcs.revertToJjPointer(snapshot.commitId, repo.dir);
      expect(result.success).toBe(true);

      // The post-capture addition is gone and the edited file is back to the
      // captured contents — the working copy mirrors the durable handle.
      const addedExists = await fs
        .stat(path.join(repo.dir, "added-later.txt"))
        .then(() => true)
        .catch(() => false);
      expect(addedExists).toBe(false);
      expect(await fs.readFile(path.join(repo.dir, "kept.txt"), "utf8")).toBe("kept\n");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

// Regression for the attempt-aliasing bug: the engine keeps `@` on one change
// across attempts, so a pointer recorded as change_id resolved to the change's
// CURRENT commit and `jj restore --from` no-op'd ("Nothing changed.") while
// reporting success — DB rewound, filesystem untouched. getJjPointer must
// return the immutable commit_id so the getJjPointer -> revertToJjPointer
// round-trip restores real bytes.
describeIfJj("getJjPointer -> revertToJjPointer round-trip on the SAME change (aliasing)", () => {
  test("pointer captured on @ restores pre-edit bytes after further edits to the same change", async () => {
    const repo = await makeRepo();
    try {
      await fs.writeFile(path.join(repo.dir, "f.txt"), "state A\n");
      const pointer = await vcs.getJjPointer(repo.dir);
      expect(pointer).not.toBeNull();
      // The pointer is a hex commit id, not a k-z change id.
      expect(pointer).toMatch(/^[0-9a-f]{8,}$/);

      // Mutate the working copy WITHOUT jj new: same change, new snapshot.
      await fs.writeFile(path.join(repo.dir, "f.txt"), "state B\n");

      const result = await vcs.revertToJjPointer(/** @type {string} */ (pointer), repo.dir);
      expect(result.success).toBe(true);
      // The filesystem actually moved back — this is the assertion the old
      // change_id pointer silently failed.
      expect(await fs.readFile(path.join(repo.dir, "f.txt"), "utf8")).toBe("state A\n");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("legacy change_id pointer fails closed without changing filesystem bytes", async () => {
    const repo = await makeRepo();
    try {
      await fs.writeFile(path.join(repo.dir, "f.txt"), "state A\n");
      const legacyPointer = await repo.currentChangeId();
      await fs.writeFile(path.join(repo.dir, "f.txt"), "state B\n");

      const { value: result, records } = await runVcsCapturingLogs(
        vcsEffects.revertToJjPointer(legacyPointer, repo.dir),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot restore legacy jj change_id pointer");
      expect(await fs.readFile(path.join(repo.dir, "f.txt"), "utf8")).toBe("state B\n");
      const warned = records.some(
        (record) => record.level === "WARN" && record.message.includes("legacy jj change_id pointer"),
      );
      expect(warned).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
