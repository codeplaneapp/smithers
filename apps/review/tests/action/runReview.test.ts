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
  });

  test("GitHub Actions invocation crosses a distinct UID with an empty inherited environment", () => {
    const invocation = buildReviewSpawnCommand({
      bunPath: "/trusted/bun",
      args: ["review.ts"],
      env: { PATH: "/safe/bin", ANTHROPIC_API_KEY: "local_dummy_only" },
      sandboxUser: "smithers-review-sandbox",
    });
    expect(invocation.command).toBe("sudo");
    expect(invocation.args.slice(0, 6)).toEqual([
      "-n", "-u", "smithers-review-sandbox", "--", "env", "-i",
    ]);
    expect(invocation.args).toContain("ANTHROPIC_API_KEY=local_dummy_only");
    expect(invocation.args).not.toContain("GH_TOKEN=write-token");
    expect(invocation.args).not.toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN=oidc-request");
  });

  test("resolves with 0 when the process exits 0", async () => {
    const code = await runReview({
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
    const code = await runReview({
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
      await runReview({
        ...boundary,
        smithersRoot: tmp,
        workspace: tmpdir(),
        prNumber: 99,
        inferenceEnv: { SMITHERS_FAKE_BUN_LOG: log },
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[]; trustedPolicy: string };
      expect(logged.args[0]).toBe(join(tmp, "apps", "review", "src", "cli", "main.ts"));
      expect(logged.trustedPolicy).toBe("1");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes workspace, --pr, and prNumber without exposing publish mode to the child", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReview({
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
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("appends --quiz <mode> when quiz is set, and omits it otherwise", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReview({
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

      await runReview({
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
      await runReview({
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
