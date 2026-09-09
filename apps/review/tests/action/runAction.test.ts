import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ACTION = fileURLToPath(new URL("../../action/src/runAction.ts", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));
// Package root so bun can resolve tsconfig paths from the correct base
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnAction(env: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", RUN_ACTION], {
    cwd: PKG_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

describe("runAction (subprocess)", () => {
  let tmp = "";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "smithers-runaction-"));
  });

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  test("exits 0 with a notice when GITHUB_EVENT_PATH is empty", () => {
    const result = spawnAction({ GITHUB_EVENT_PATH: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("GITHUB_EVENT_PATH is empty");
  });

  test("exits 0 with a notice when GITHUB_EVENT_PATH is unset", () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.GITHUB_EVENT_PATH;
    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("GITHUB_EVENT_PATH is empty");
  });

  test("exits 0 with a skip notice when the event is a draft PR", async () => {
    const payload = {
      action: "opened",
      pull_request: {
        number: 1,
        draft: true,
        head: { sha: "abc", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toMatch(/skipped/i);
  });

  test("exits 0 with a skip notice for a fork PR", async () => {
    const payload = {
      action: "opened",
      pull_request: {
        number: 2,
        draft: false,
        head: { sha: "abc", repo: { full_name: "fork/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnAction({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toMatch(/skipped/i);
  });

  const commentPayload = {
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/octo/widgets/pulls/7" } },
    comment: { body: "@smithers review", author_association: "OWNER" },
  };

  function spawnCommentAction(ghEnv: Record<string, string>, eventPath: string): SpawnResult {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // No repository → status comments are a no-op; no OIDC vars → a run that
    // passes the fork check fails deterministically at fetchOidcToken.
    delete env.GITHUB_REPOSITORY;
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env: {
        ...env,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_WORKSPACE: PKG_ROOT,
        SMITHERS_GH_BIN: FAKE_GH,
        ...ghEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? 1,
    };
  }

  test("exits 0 with a skip notice when a comment-triggered PR is a fork", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = spawnCommentAction({ SMITHERS_FAKE_GH_STDOUT: '{"isCrossRepository":true}' }, eventPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("fork pull requests are not reviewed");
  });

  test("continues past the fork check for a same-repo comment-triggered PR", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = spawnCommentAction({ SMITHERS_FAKE_GH_STDOUT: '{"isCrossRepository":false}' }, eventPath);
    // Fork check passed → the next step (fetchOidcToken) fails without OIDC vars.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("fork pull requests are not reviewed");
    expect(result.stderr).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("fails closed when the PR's fork status cannot be resolved", async () => {
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(commentPayload));
    const result = spawnCommentAction({ SMITHERS_FAKE_GH_EXIT: "7" }, eventPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not determine whether PR #7 is a fork PR");
  });

  test("throws and exits non-zero when OIDC vars are missing for a valid PR event", async () => {
    // When a valid PR event passes the gate, runAction calls fetchOidcToken
    // which throws if the OIDC env vars are not set.
    const payload = {
      action: "opened",
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    env.GITHUB_EVENT_NAME = "pull_request";
    env.GITHUB_EVENT_PATH = eventPath;
    env.GITHUB_REPOSITORY = "octo/widgets";
    env.GITHUB_WORKSPACE = PKG_ROOT;
    env.GITHUB_RUN_ID = "";
    env.SMITHERS_GH_BIN = FAKE_GH;
    env.SMITHERS_FAKE_GH_STDOUT = "";
    env.SMITHERS_FAKE_GH_EXIT = "0";
    const ghLog = join(tmp, "gh.log");
    env.SMITHERS_FAKE_GH_LOG = ghLog;

    // Refuse to launch this valid event with a real GitHub executable.
    expect(env.SMITHERS_GH_BIN).toBe(FAKE_GH);
    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Gate passes (valid PR) → fetchOidcToken throws → process.exit(1)
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");

    const calls = (await readFile(ghLog, "utf8")).split("--- fake gh call ---\n").slice(1);
    expect(calls).toHaveLength(4);
    const endpoint = "repos/octo/widgets/issues/42/comments";
    const lookup = [
      "api",
      "--paginate",
      endpoint,
      "--jq",
      '.[] | select(.body | startswith("<!-- smithers-review-status -->")) | .id',
    ];
    expect(calls[0]!.trim().split("\n")).toEqual(lookup);
    expect(calls[2]!.trim().split("\n")).toEqual(lookup);
    const statuses = [calls[1]!, calls[3]!].map((call) => {
      const lines = call.trim().split("\n");
      expect(lines.slice(0, 6)).toEqual(["api", "--method", "POST", endpoint, "--input", "-"]);
      return (JSON.parse(lines.slice(6).join("\n")) as { body: string }).body;
    });
    expect(statuses[0]).toBe("<!-- smithers-review-status -->\n🔍 smithers review started");
    expect(statuses[1]).toStartWith("<!-- smithers-review-status -->\n❌ smithers review failed before it could start:");
    expect(statuses[1]).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    // Not the 5s default: a cold bun subprocess boot runs 3-6s on loaded CI
    // runners.
  }, 20_000);
});
