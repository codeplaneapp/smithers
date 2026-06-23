import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ACTION = fileURLToPath(new URL("../../action/src/runAction.ts", import.meta.url));
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
    const env: Record<string, string> = { ...process.env as Record<string, string> };
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

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    env.GITHUB_EVENT_NAME = "pull_request";
    env.GITHUB_EVENT_PATH = eventPath;

    const result = Bun.spawnSync(["bun", RUN_ACTION], {
      cwd: PKG_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Gate passes (valid PR) → fetchOidcToken throws → process.exit(1)
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
  });
});
