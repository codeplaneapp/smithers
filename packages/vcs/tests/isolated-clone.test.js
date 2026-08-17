import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedClone, listGitRefs } from "../src/isolated-clone.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-isolated-source-"));
  cleanup.push(dir);
  git(dir, "init");
  git(dir, "config", "user.email", "test@smithers.local");
  git(dir, "config", "user.name", "Smithers Test");
  writeFileSync(join(dir, "tracked.txt"), "pinned\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "pinned");
  return dir;
}

describe("isolated clone capsule", () => {
  test("pins only the requested commit while the source working tree is hot and emits a verified handoff", async () => {
    const source = repository();
    const pinned = git(source, "rev-parse", "HEAD");
    execFileSync(process.execPath, [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(join(source, "tracked.txt"))}, 'hot edit\\n')`,
    ]);
    const capsule = await createIsolatedClone({ repo: source, at: pinned });
    cleanup.push(capsule.path);

    expect(readFileSync(join(capsule.path, "tracked.txt"), "utf8")).toBe("pinned\n");
    expect(git(capsule.path, "remote")).toBe("");
    expect(await listGitRefs(capsule.path)).toEqual([]);
    expect(git(capsule.path, "rev-parse", "HEAD")).toBe(pinned);

    writeFileSync(join(capsule.path, "new.txt"), "from capsule\n");
    const outputDir = mkdtempSync(join(tmpdir(), "smithers-isolated-output-"));
    cleanup.push(outputDir);
    const handoff = await capsule.emitBundle({ outputDir, name: "handoff" });
    expect(handoff.manifest.sourceCommit).toBe(pinned);
    expect(handoff.manifest.dirtyPaths).toContain("new.txt");
    expect(handoff.manifest.freshImportVerified).toBe(true);
    expect(readFileSync(handoff.patchPath, "utf8")).toContain("new.txt");
  });

  test("runs commands in the clone with the documented scrubbed environment", async () => {
    const source = repository();
    const capsule = await createIsolatedClone({ repo: source, at: "HEAD" });
    cleanup.push(capsule.path);
    process.env.GIT_EDITOR = "host-editor";
    process.env.SMITHERS_HOME = "/host/accounts";
    try {
      const result = await capsule.run(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({cwd:process.cwd(),git:process.env.GIT_EDITOR,home:process.env.SMITHERS_HOME,path:!!process.env.PATH,explicit:process.env.CAPSULE_EXPLICIT}))",
        ],
        { env: { CAPSULE_EXPLICIT: "yes" } },
      );
      expect(JSON.parse(result.stdout)).toEqual({ cwd: realpathSync(capsule.path), path: true, explicit: "yes" });
    } finally {
      delete process.env.GIT_EDITOR;
      delete process.env.SMITHERS_HOME;
    }
  });

  test("streams ref inventories larger than the synchronous pipe buffer", async () => {
    const source = repository();
    const commit = git(source, "rev-parse", "HEAD");
    const updates = Array.from(
      { length: 12_000 },
      (_, index) => `create refs/jj/keep/${String(index).padStart(6, "0")}-${"x".repeat(64)} ${commit}`,
    ).join("\n");
    execFileSync("git", ["update-ref", "--stdin"], { cwd: source, input: `${updates}\n` });
    const refs = await listGitRefs(source);
    expect(refs.length).toBeGreaterThanOrEqual(12_001);
    expect(refs.reduce((bytes, ref) => bytes + ref.name.length + ref.objectId.length + 2, 0)).toBeGreaterThan(
      1_000_000,
    );
  }, 30_000);
});
