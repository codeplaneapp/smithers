import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPersistedGitCredentials,
  prCheckoutEnvironment,
  pullRequestReference,
  readWalkthroughFile,
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

const livePr = {
  number: 2,
  url: "https://github.com/octo/widgets/pull/2",
  baseRefName: "main",
  headRefName: "change",
  headRefOid: WORKSPACE_HEAD,
  title: "Change",
  body: "",
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
    expect(pullRequestReference({ ...livePr, owner: "octo", repo: "widgets", headSha: WORKSPACE_HEAD }, 2))
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
  });

  test("walkthrough publication accepts only a regular file and never follows a child-selected symlink", async () => {
    const walkthrough = join(tmp, "walkthrough.html");
    const link = join(tmp, "walkthrough-link.html");
    await writeFile(walkthrough, "<html>safe</html>");
    await symlink(walkthrough, link);
    expect(readWalkthroughFile(walkthrough).toString()).toBe("<html>safe</html>");
    expect(() => readWalkthroughFile(link)).toThrow();
  });

  test("trusted-collaborator fork PRs continue into the metered/OIDC path", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({
      action: "opened",
      pull_request: {
        number: 2,
        draft: false,
        author_association: "COLLABORATOR",
        html_url: livePr.url,
        title: "Change",
        body: "",
        head: { sha: livePr.headRefOid, ref: "change", repo: { full_name: "fork/widgets" } },
        base: { ref: "main", repo: { full_name: "octo/widgets" } },
      },
    }));
    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "octo/widgets",
      GITHUB_WORKSPACE: PKG_ROOT,
      SMITHERS_REVIEW_WORKSPACE: PKG_ROOT,
      SMITHERS_GH_BIN: FAKE_GH,
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify(livePr),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("fork pull requests are not reviewed");
    expect(result.stderr).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("comment-triggered reviews also require OIDC after resolving the PR with read-only GitHub access", async () => {
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
      SMITHERS_FAKE_GH_STDOUT: JSON.stringify(livePr),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
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
