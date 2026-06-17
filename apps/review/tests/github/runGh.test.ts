import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGh } from "../../src/github/runGh";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("runGh", () => {
  test("executes gh in the repo directory, passes stdin, and reports stderr on failure", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "smithers-review-gh-"));
    const bin = join(tmp, "bin");
    const log = join(tmp, "gh-log.json");
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bun
const input = await Bun.stdin.text();
await Bun.write(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input }));
if (process.argv.includes("fail")) {
  console.error("fixture failure");
  process.exit(7);
}
process.stdout.write("fixture stdout");
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    try {
      await expect(runGh(tmp, ["api", "ok"], "payload")).resolves.toBe("fixture stdout");
      await expect(Bun.file(log).json()).resolves.toEqual({
        cwd: await realpath(tmp),
        args: ["api", "ok"],
        input: "payload",
      });
      await expect(runGh(tmp, ["api", "fail"], "")).rejects.toThrow("fixture failure");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
