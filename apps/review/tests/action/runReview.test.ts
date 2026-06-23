import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runReview } from "../../action/src/runReview";

const FAKE_BUN = fileURLToPath(new URL("./fixtures/fake-bun", import.meta.url));

afterEach(() => {
  delete process.env.SMITHERS_FAKE_BUN_LOG;
  delete process.env.SMITHERS_FAKE_BUN_EXIT;
});

describe("runReview", () => {
  test("resolves with 0 when the process exits 0", async () => {
    const code = await runReview({
      // smithersRoot must be a real directory (spawn cwd must exist)
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 42,
      inferenceEnv: { ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_API_KEY: "srs_tok" },
      publishUrl: "https://review.test",
      publishToken: "srs_tok",
      bunPath: FAKE_BUN,
    });
    expect(code).toBe(0);
  });

  test("resolves with non-zero when the process exits non-zero", async () => {
    process.env.SMITHERS_FAKE_BUN_EXIT = "7";
    const code = await runReview({
      smithersRoot: tmpdir(),
      workspace: tmpdir(),
      prNumber: 7,
      inferenceEnv: {},
      publishUrl: "https://review.test",
      publishToken: "srs_tok",
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
        smithersRoot: tmp,
        workspace: tmpdir(),
        prNumber: 99,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      expect(logged.args[0]).toBe(join(tmp, "apps", "review", "src", "cli", "main.ts"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes workspace, --pr, prNumber, and --publish as arguments", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-root-"));
    const log = join(tmp, "bun-log.json");
    process.env.SMITHERS_FAKE_BUN_LOG = log;
    try {
      await runReview({
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 55,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
        bunPath: FAKE_BUN,
      });
      const logged = (await Bun.file(log).json()) as { cwd: string; args: string[] };
      expect(logged.args[1]).toBe("/some/workspace");
      expect(logged.args[2]).toBe("--pr");
      expect(logged.args[3]).toBe("55");
      expect(logged.args[4]).toBe("--publish");
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
        smithersRoot: tmp,
        workspace: "/some/workspace",
        prNumber: 1,
        inferenceEnv: {},
        publishUrl: "https://review.test",
        publishToken: "srs_tok",
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
