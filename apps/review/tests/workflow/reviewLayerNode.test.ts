import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The durable composition, driven through a REAL provider route.
 *
 * Every other flow test resolves its seats to a scripted `Model`, which builds
 * no HTTP request and so never meets the capability kernel. The shipped entry
 * points do the opposite: `bin/smithers-review.mjs` and the GitHub action both
 * run `layerNode`, where the host installs a guarded HTTP client and checks
 * every model request as `model:call` against its grant store. A composition
 * that grants no rule for it suspends the run on a permission nobody is there
 * to answer, and the CLI dies with "All fibers interrupted without error".
 *
 * The provider is a local fixture rather than a credential, so the check runs
 * on every machine: the URL is absolute, the route is a real `Route`, and the
 * kernel sees a real `model:call` on a real host and model id.
 *
 * Node, not Bun: `layerNode` builds the host's undici client, whose dispatcher
 * teardown is unavailable under Bun, so the composition the CLI runs can only
 * be exercised from Node. The driver prints one JSON line.
 */

const driver = fileURLToPath(new URL("./fixtures/runNodeReview.ts", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

/** A repository whose working tree changes one file against its first commit. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-layer-node-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "commit.gpgsign", "false"]);
  mkdirSync(dirname(join(dir, "src/file0.ts")), { recursive: true });
  writeFileSync(join(dir, "src/file0.ts"), "export const value0 = 0;\n");
  run(["add", "."]);
  run(["commit", "-m", "base"]);
  writeFileSync(join(dir, "src/file0.ts"), "export const value0 = 0;\nexport const next0 = 1;\n");
  return dir;
}

describe("the durable composition against a real provider route", () => {
  test("reaches the model through the capability kernel and returns findings", () => {
    const repo = tempRepo();
    const result = spawnSync("node", [driver, repo, join(repo, ".smithers-review", "review.db")], {
      encoding: "utf8",
      env: process.env,
      timeout: 180_000,
    });

    const line = result.stdout.trim().split("\n").filter((text) => text.startsWith("{")).at(-1);
    // No JSON line at all means the driver died before it could report, and its
    // stderr is the only evidence of why.
    expect(line ?? `no report; stderr: ${result.stderr}`).toContain("{");
    const report = JSON.parse(line!) as {
      ok: boolean;
      requests: number;
      status?: string;
      paths?: string[];
      error?: string;
    };

    // The failure this test exists for suspends the run on an ungranted
    // `model:call`, which surfaces as an interrupt rather than a named error,
    // so the message is worth reporting when it happens.
    expect(report.error ?? "none").toBe("none");
    expect(report.ok).toBe(true);
    // The kernel let the call through: the fixture provider was actually asked,
    // and the answer it streamed became the review's finding.
    expect(report.requests).toBeGreaterThan(0);
    expect(report.status).toBe("success");
    expect(report.paths).toEqual(["src/file0.ts"]);
  }, 240_000);
});
