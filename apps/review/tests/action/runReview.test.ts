import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReviewProcessEnvironment,
  buildReviewSpawnCommand,
  runReview,
  workflowCommandFence,
} from "../../action/src/runReview";

const FAKE_BUN = fileURLToPath(new URL(process.platform === "win32" ? "./fixtures/fake-bun.cmd" : "./fixtures/fake-bun", import.meta.url));
const boundary = {
  actionPath: tmpdir(),
  ghFixturePath: join(tmpdir(), "fixture.json"),
  capturePath: join(tmpdir(), "capture.json"),
  outputDir: tmpdir(),
};
const directSpawnRuntime = {
  prepareIsolatedUser: () => undefined,
  cleanupIsolatedUser: () => {
    throw new Error("direct-spawn test runtime must not restore sandbox ownership");
  },
};

function runReviewFixture(input: Parameters<typeof runReview>[0]): Promise<number> {
  return runReview(input, directSpawnRuntime);
}

afterEach(() => {
  delete process.env.SMITHERS_FAKE_BUN_LOG;
  delete process.env.SMITHERS_FAKE_BUN_EXIT;
});

describe("runReview", () => {
  test("builds an opaque Actions workflow-command fence", () => {
    expect(workflowCommandFence("reviewFence123")).toEqual({
      stop: "::stop-commands::reviewFence123\n",
      resume: "::reviewFence123::\n",
    });
    expect(() => workflowCommandFence("bad::token")).toThrow(/invalid/);
  });

  test("review process environment drops GitHub, OIDC, and unrelated job secrets", () => {
    const env = buildReviewProcessEnvironment({
      baseEnv: {
        PATH: "/safe/bin",
        LANG: "C.UTF-8",
        RUNNER_TEMP: "/runner/shared-temp",
        GH_TOKEN: "write-token",
        GITHUB_TOKEN: "write-token-2",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
        CODEX_AUTH_JSON: '{"long_lived":true}',
        CLAUDE_CODE_OAUTH_TOKEN: "long-lived-oauth",
        DEPLOY_KEY: "unrelated-secret",
      },
      isolatedHome: "/isolated/home",
      explicit: { ANTHROPIC_API_KEY: "srs_short_lived" },
    });
    expect(env.PATH).toBe("/safe/bin");
    expect(env.HOME).toBe("/isolated/home");
    for (const key of ["RUNNER_TEMP", "TMPDIR", "TMP", "TEMP"]) {
      expect(env[key]).toBe("/isolated/home/tmp");
    }
    expect(env.ANTHROPIC_API_KEY).toBe("srs_short_lived");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "CODEX_AUTH_JSON",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "DEPLOY_KEY",
    ]) expect(key in env).toBe(false);
    expect(() => buildReviewProcessEnvironment({
      baseEnv: {}, isolatedHome: "/isolated/home", explicit: { HOME: "/attacker" },
    })).toThrow(/HOME/);
    expect(() => buildReviewProcessEnvironment({
      baseEnv: {}, isolatedHome: "/isolated/home", explicit: { GITHUB_TOKEN: "reintroduced" },
    })).toThrow(/GITHUB_TOKEN/);
  });

  test("GitHub Actions invocation crosses a distinct UID in a descendant-reaping PID namespace", () => {
    const invocation = buildReviewSpawnCommand({
      bunPath: "/trusted/bun",
      args: ["review.ts"],
      env: { PATH: "/safe/bin", ANTHROPIC_API_KEY: "local_dummy_only" },
      sandboxIdentity: { user: "smithers-r-test", uid: "2001", gid: "2001" },
    });
    expect(invocation.command).toBe("/usr/bin/sudo");
    expect(invocation.args.slice(0, 8)).toEqual([
      "-n", "--", "/usr/bin/unshare", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "/usr/bin/setpriv",
    ]);
    expect(invocation.args).toContain("--reuid=2001");
    expect(invocation.args).toContain("--regid=2001");
    expect(invocation.args).toContain("--no-new-privs");
    expect(invocation.args).toContain("--bounding-set=-all");
    expect(invocation.args).toContain("/usr/bin/env");
    expect(invocation.args).toContain("-i");
    expect(invocation.args).toContain("ANTHROPIC_API_KEY=local_dummy_only");
    expect(invocation.args).toContain("USER=smithers-r-test");
    expect(invocation.args).toContain("LOGNAME=smithers-r-test");
    expect(invocation.args).not.toContain("GH_TOKEN=write-token");
    expect(invocation.args).not.toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN=oidc-request");
  });

  test("resolves with 0 when the process exits 0", async () => {
    const code = await runReviewFixture({
      ...boundary,
      // smithersRoot must be a real directory (spawn cwd must exist)
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 42,
      inferenceEnv: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_API_KEY: "srs_tok" },
      bunPath: FAKE_BUN,
    });
    expect(code).toBe(0);
  });

  test("resolves with non-zero when the process exits non-zero", async () => {
    process.env.SMITHERS_FAKE_BUN_EXIT = "7";
    const code = await runReviewFixture({
      ...boundary,
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 7,
      inferenceEnv: { SMITHERS_FAKE_BUN_EXIT: "7" },
      bunPath: FAKE_BUN,
    });
    expect(code).toBe(7);
  });

  test("passes the CLI path derived from smithersRoot as the first argument", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: tmpdir(),
        prNumber: 99,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as {
        cwd: string;
        args: string[];
        trustedPolicy: string;
        gitConfigNoSystem: string;
        gitTerminalPrompt: string;
      };
      expect(logged.args[0]).toBe(join(tmp, "apps", "review", "src", "cli", "main.ts"));
      expect(logged.trustedPolicy).toBe("1");
      expect(logged.gitConfigNoSystem).toBe("1");
      expect(logged.gitTerminalPrompt).toBe("0");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes workspace, --pr, and prNumber without exposing publish mode to the child", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      expect(logged.args[1]).toBe("/some/workspace");
      expect(logged.args[2]).toBe("--pr");
      expect(logged.args[3]).toBe("55");
      expect(logged.args).not.toContain("--publish");
      expect(logged.args).toContain("--concurrency");
      expect(logged.args[logged.args.indexOf("--concurrency") + 1]).toBe("16");
      expect(logged.args).toContain("--timeout");
      expect(logged.args[logged.args.indexOf("--timeout") + 1]).toBe("5");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes protected manifest and summary paths explicitly to the isolated child", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: tmpdir(),
        prNumber: 55,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        immutableManifestPath: "/trusted/immutable.jsonl",
        summaryPath: "/sandbox/summary.json",
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { manifest: string; summary: string };
      expect(logged.manifest).toBe("/trusted/immutable.jsonl");
      expect(logged.summary).toBe("/sandbox/summary.json");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("appends --quiz <mode> when quiz is set, and omits it otherwise", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        quiz: "on",
        bunPath: FAKE_BUN,
      });
      let logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args.slice(-2)).toEqual(["--quiz", "on"]);

      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        bunPath: FAKE_BUN,
      });
      logged = (await Bun.file(log).json()) as { args: string[] };
      expect(logged.args).not.toContain("--quiz");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runs with smithersRoot as cwd, not the workspace", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReviewFixture({
        ...boundary,
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 1,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      // cwd should be smithersRoot; use realpath to resolve macOS symlinks (/tmp → /private/tmp)
      expect(logged.cwd).toBe(await realpath(tmp));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
