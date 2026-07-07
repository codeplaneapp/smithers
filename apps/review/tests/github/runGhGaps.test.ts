import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGh } from "../../src/github/runGh";

const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url));

afterEach(() => {
  delete process.env.SMITHERS_GH_BIN;
  delete process.env.SMITHERS_FAKE_GH_LOG;
});

describe("runGh failure branches", () => {
  test("throws when the gh binary cannot be spawned (spawn error)", async () => {
    process.env.SMITHERS_GH_BIN = "/nonexistent/path/to/gh-binary-xyz";
    const tmp = await mkdtemp(join(tmpdir(), "smithers-runGh-err-"));
    try {
      await expect(runGh(tmp, ["api", "x"])).rejects.toThrow("gh api x failed:");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("throws with the stderr detail when gh exits non-zero", async () => {
    process.env.SMITHERS_GH_BIN = FAKE_GH;
    const tmp = await mkdtemp(join(tmpdir(), "smithers-runGh-fail-"));
    process.env.SMITHERS_FAKE_GH_LOG = join(tmp, "log.json");
    try {
      await expect(runGh(tmp, ["api", "fail"])).rejects.toThrow("gh api fail failed: fixture failure");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
