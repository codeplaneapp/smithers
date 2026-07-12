import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPersistedGitCredentials,
  changedFileSet,
  immutableDiffManifest,
  prCheckoutEnvironment,
  pullRequestReference,
  readWalkthroughFile,
  serializeValidatedReviewArtifact,
  writeReviewArtifact,
} from "../../action/src/runAction";

const RUN_ACTION = fileURLToPath(new URL("../../action/src/runAction.ts", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKSPACE_HEAD = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: PKG_ROOT,
  encoding: "utf8",
}).trim();

function spawnAction(env: Record<string, string>) {
  const clean: Record<string, string> = { ...process.env as Record<string, string> };
  delete clean.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete clean.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const result = Bun.spawnSync(["bun", RUN_ACTION], {
    cwd: PKG_ROOT,
    env: { ...clean, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

async function disposableActionRepository(root: string): Promise<{ repo: string; head: string }> {
  const repo = join(root, "action-repository");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Review test"], { cwd: repo });
  await writeFile(join(repo, "fixture.txt"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return { repo, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

function parentOriginMain(): string | null {
  try { return execFileSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], { cwd: PKG_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

const livePr = {
  number: 2,
  url: "https://github.com/octo/widgets/pull/2",
  baseRefName: "main",
  headRefName: "change",
  headRefOid: WORKSPACE_HEAD,
  title: "Change",
  body: "",
  state: "OPEN",
  isDraft: false,
};

describe("runAction analysis boundary (subprocess)", () => {
  let tmp = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "smithers-runaction-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("exits 0 with a notice when GITHUB_EVENT_PATH is empty", () => {
    const result = spawnAction({ GITHUB_EVENT_PATH: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GITHUB_EVENT_PATH is empty");
  });

  test("qualifies fork lookups with the immutable base-repository PR URL", () => {
    expect(pullRequestReference({
      ...livePr,
      owner: "octo",
      repo: "widgets",
      headSha: WORKSPACE_HEAD,
      state: "open",
      draft: false,
    }, 2))
      .toBe("https://github.com/octo/widgets/pull/2");
    expect(pullRequestReference(null, 2)).toBe("2");
    expect(prCheckoutEnvironment({ GH_TOKEN: "read-only" })).toMatchObject({
      GH_TOKEN: "read-only",
      GIT_LFS_SKIP_SMUDGE: "1",
    });
  });

  test("draft PRs stop before any credential or GitHub operation", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "opened",
      pull_request: {
        number: 1,
        draft: true,
        head: { sha: "a".repeat(40), repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/skipped.*draft/i);
  });

  test("refuses a checkout that persisted an HTTP authorization header", () => {
    execFileSync("git", ["init", "-q", tmp]);
    expect(() => assertNoPersistedGitCredentials(tmp)).not.toThrow();
    execFileSync("git", ["config", "--local", "http.https://github.com/.extraheader", "AUTHORIZATION: basic secret"], { cwd: tmp });
    expect(() => assertNoPersistedGitCredentials(tmp)).toThrow(/credential|header/i);
    execFileSync("git", ["config", "--local", "--unset-all", "http.https://github.com/.extraheader"], { cwd: tmp });
    execFileSync("git", ["remote", "add", "origin", "https://persisted-token@github.com/octo/widgets.git"], { cwd: tmp });
    expect(() => assertNoPersistedGitCredentials(tmp)).toThrow(/credential/i);
  });

  test("walkthrough publication accepts only a regular file and never follows a child-selected symlink", async () => {
    const walkthrough = join(tmp, "walkthrough.html");
    const link = join(tmp, "walkthrough-link.html");
    await writeFile(walkthrough, "<html>safe</html>");
    await symlink(walkthrough, link);
    expect(readWalkthroughFile(walkthrough).toString()).toBe("<html>safe</html>");
    expect(() => readWalkthroughFile(link)).toThrow();
    if (process.platform !== "win32") {
      const fifo = join(tmp, "walkthrough-fifo.html");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(() => readWalkthroughFile(fifo)).toThrow(/regular file/);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  test("writes a complete bounded review artifact through an atomic private file", async () => {
    const artifact = join(tmp, "review-artifact.json");
    const input = {
      repository: "octo/widgets",
      prNumber: 2,
      headSha: WORKSPACE_HEAD,
      baseSha: "b".repeat(40),
      eventName: "pull_request",
      review: {
        commit_id: WORKSPACE_HEAD,
        event: "COMMENT",
        body: "<!-- smithers-review -->\nSafe review",
        comments: [{ path: "src/app.ts", line: 1, side: "RIGHT", body: "Safe finding" }],
      },
      manifestText: JSON.stringify({
        oldPath: "src/app.ts", newPath: "src/app.ts", filename: "src/app.ts", status: "A", additions: 1, deletions: 0, binary: false,
        patch: `diff --git a/src/app.ts b/src/app.ts\nnew file mode 100644\nindex ${"0".repeat(40)}..${"1".repeat(40)}\n--- /dev/null\n+++ b/src/app.ts\n@@ -0,0 +1 @@\n+safe\n`, newMode: "100644",
      }),
    };
    const serialized = serializeValidatedReviewArtifact({ ...input, changedFiles: ["src/app.ts"] });
    writeReviewArtifact(artifact, serialized);
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual({
      schemaVersion: 2,
      repository: "octo/widgets",
      prNumber: 2,
      headSha: WORKSPACE_HEAD,
      baseSha: "b".repeat(40),
      eventName: "pull_request",
      changedFiles: ["src/app.ts"],
      review: input.review,
    });
    if (process.platform !== "win32") expect((await lstat(artifact)).mode & 0o077).toBe(0);
    expect(() => serializeValidatedReviewArtifact({ ...input, repository: "attacker.invalid", changedFiles: ["src/app.ts"] })).toThrow(/repository/);

    const existing = join(tmp, "existing.json");
    await writeFile(existing, "keep-existing");
    expect(() => writeReviewArtifact(existing, serialized)).toThrow();
    expect(await readFile(existing, "utf8")).toBe("keep-existing");

    const target = join(tmp, "artifact-target.json");
    const link = join(tmp, "artifact-link.json");
    await writeFile(target, "keep-target");
    await symlink(target, link);
    expect(() => writeReviewArtifact(link, serialized)).toThrow();
    expect(await readFile(target, "utf8")).toBe("keep-target");
    expect((await readdir(tmp)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("derives a strict changed-file capability from raw or double-encoded gh JSON lines", () => {
    const files = changedFileSet([
      JSON.stringify({ oldPath: "docs/readme.md", newPath: "docs/readme.md", filename: "docs/readme.md", status: "A", additions: 0, deletions: 0, binary: false, patch: `diff --git a/docs/readme.md b/docs/readme.md\nnew file mode 100644\nindex ${"0".repeat(40)}..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n`, newMode: "100644" }),
      JSON.stringify({ oldPath: "src/app.ts", newPath: "src/app.ts", filename: "src/app.ts", status: "A", additions: 0, deletions: 0, binary: false, patch: `diff --git a/src/app.ts b/src/app.ts\nnew file mode 100644\nindex ${"0".repeat(40)}..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n`, newMode: "100644" }),
    ].join("\n"));
    expect(files).toEqual(new Set(["src/app.ts", "docs/readme.md"]));
    expect(() => changedFileSet(JSON.stringify({ filename: "/etc/passwd" }))).toThrow(/invalid/);
    expect(() => changedFileSet("not-json")).toThrow();
  });

  test("binds manifest, patch, and capability to merge-base/head and treats hostile names literally", async () => {
    const repo = join(tmp, "immutable-repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "common.txt"), "common\n");
    git(["add", "."]);
    git(["commit", "-qm", "common"]);
    const common = git(["rev-parse", "HEAD"]);
    git(["switch", "-qc", "head"]);
    await writeFile(join(repo, "*"), "literal\n");
    git(["--literal-pathspecs", "add", "--", "*"]);
    git(["commit", "-qm", "head"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["switch", "-q", "main"]);
    await writeFile(join(repo, "base-only.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    const records = immutableDiffManifest(repo, base, head).split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.filename)).toEqual(["*"]);
    expect(records[0].patch).toContain("literal");
    expect(changedFileSet(records.map((record) => JSON.stringify(record)).join("\n"))).toEqual(new Set(["*"]));
    expect(common).not.toBe(base);
  });

  test("generates one manifest for deletion, rename, binary, mode-only, and newline paths", async () => {
    const repo = join(tmp, "manifest-variants");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "delete.ts"), "delete me\n");
    await writeFile(join(repo, "rename.ts"), "rename me\nkeep this\nkeep that\n");
    await writeFile(join(repo, "mode.sh"), "#!/bin/sh\necho mode\n");
    git(["add", "."]); git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    git(["switch", "-qc", "head"]);
    git(["rm", "-q", "delete.ts"]);
    git(["mv", "rename.ts", "renamed.ts"]);
    await writeFile(join(repo, "renamed.ts"), "rename me\nkeep this\nkeep that\nwith a small edit\n");
    await writeFile(join(repo, "mode.sh"), "#!/bin/sh\necho mode\n");
    execFileSync("chmod", ["+x", "mode.sh"], { cwd: repo });
    git(["update-index", "--chmod=+x", "mode.sh"]);
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
    await writeFile(join(repo, "line\nname.ts"), "newline path\n");
    git(["add", "."]); git(["commit", "-qm", "variants"]);
    const head = git(["rev-parse", "HEAD"]);
    const records = immutableDiffManifest(repo, base, head).split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.filename)).toEqual(expect.arrayContaining(["delete.ts", "renamed.ts", "mode.sh", "binary.bin", "line\nname.ts"]));
    expect(records.find((record) => record.filename === "delete.ts")).toMatchObject({ status: "D", oldPath: "delete.ts", newPath: "delete.ts" });
    expect(records.find((record) => record.filename === "renamed.ts")).toMatchObject({ status: expect.stringMatching(/^R/), oldPath: "rename.ts", newPath: "renamed.ts" });
    expect(records.find((record) => record.filename === "binary.bin")).toMatchObject({ binary: true });
    // Git preserves chmod-only changes as M; only actual type changes use T.
    expect(records.find((record) => record.filename === "mode.sh")).toMatchObject({ status: "M" });
    expect(records.find((record) => record.filename === "mode.sh")?.patch).toBeUndefined();
    expect(changedFileSet(immutableDiffManifest(repo, base, head))).toEqual(new Set(records.map((record) => record.filename)));
  });

  test("keeps immutable manifest generation working beyond the child-process default buffer", async () => {
    const repo = join(tmp, "large-immutable-repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "base.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    await writeFile(join(repo, "large.txt"), "line\n".repeat(220_000));
    git(["add", "."]);
    git(["commit", "-qm", "large"]);
    const head = git(["rev-parse", "HEAD"]);
    const records = immutableDiffManifest(repo, base, head).split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].filename).toBe("large.txt");
    expect(records[0].additions).toBe(220_000);
    expect(records[0].patch.length).toBeGreaterThan(1_000_000);
  });

  test("empty trusted-collaborator fork PRs skip before consuming metered/OIDC capacity", async () => {
    const disposable = await disposableActionRepository(tmp);
    const parentRef = parentOriginMain();
    const pr = { ...livePr, headRefOid: disposable.head };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "opened",
      pull_request: {
        number: 2,
        draft: false,
        state: "open",
        author_association: "COLLABORATOR",
        html_url: livePr.url,
        title: "Change",
        body: "",
        head: { sha: pr.headRefOid, ref: "change", repo: { full_name: "fork/widgets" } },
        base: { ref: "main", sha: disposable.head, repo: { full_name: "octo/widgets" } },
      },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
      GITHUB_WORKSPACE: disposable.repo,
      SMITHERS_REVIEW_WORKSPACE: disposable.repo,
      SMITHERS_REVIEW_BASE_WORKSPACE: disposable.repo,
      SMITHERS_GH_BIN: FAKE_GH,
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify(pr),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("fork pull requests are not reviewed");
    expect(result.stdout).toContain("contains no changed files");
    expect(parentOriginMain()).toBe(parentRef);
  });

  test("empty comment-triggered reviews skip after read-only PR resolution and before OIDC", async () => {
    const disposable = await disposableActionRepository(tmp);
    const parentRef = parentOriginMain();
    const pr = { ...livePr, headRefOid: disposable.head };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 2, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/2" } },
      comment: { body: "@smithers review", author_association: "OWNER" },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
      GITHUB_WORKSPACE: disposable.repo,
      SMITHERS_REVIEW_WORKSPACE: disposable.repo,
      SMITHERS_REVIEW_BASE_WORKSPACE: disposable.repo,
      SMITHERS_GH_BIN: FAKE_GH,
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify(pr),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("contains no changed files");
    expect(parentOriginMain()).toBe(parentRef);
  });

  test("comment-triggered reviews skip pull requests targeting a non-main base", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 2, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/2" } },
      comment: { body: "@smithers review", author_association: "OWNER" },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
      GITHUB_WORKSPACE: PKG_ROOT,
      SMITHERS_REVIEW_WORKSPACE: PKG_ROOT,
      SMITHERS_GH_BIN: FAKE_GH,
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify({ ...livePr, baseRefName: "release" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("only pull requests targeting main");
    expect(result.stderr).not.toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("comment-triggered reviews skip a live PR that closed or became draft", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 2, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/2" } },
      comment: { body: "@smithers review", author_association: "OWNER" },
    }));
    for (const pr of [
      { ...livePr, state: "CLOSED", isDraft: false },
      { ...livePr, state: "OPEN", isDraft: true },
    ]) {
      const result = spawnAction({
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "octo/widgets",
        GITHUB_WORKSPACE: PKG_ROOT,
        SMITHERS_REVIEW_WORKSPACE: PKG_ROOT,
        SMITHERS_GH_BIN: FAKE_GH,
        SMITHERS_FAKE_GH_STDOUT: JSON.stringify(pr),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(pr.state === "CLOSED" ? /no longer open/ : /is a draft/);
      expect(result.stderr).not.toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    }
  });

  test("comment-triggered reviews reject a checkout that raced to another head", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 2, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/2" } },
      comment: { body: "@smithers review", author_association: "OWNER" },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
      GITHUB_WORKSPACE: PKG_ROOT,
      SMITHERS_REVIEW_WORKSPACE: PKG_ROOT,
      SMITHERS_GH_BIN: FAKE_GH,
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify({ ...livePr, headRefOid: "b".repeat(40) }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("checked-out pull request head");
    expect(result.stderr).not.toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });
});
