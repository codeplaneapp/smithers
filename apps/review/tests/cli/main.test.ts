import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunSummaryLine, parseQuizColumn, runReviewCli } from "../../src/cli/main.ts";

const BIN = fileURLToPath(new URL("../../bin/smithers-review.mjs", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnMain(args: string[], env?: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["node", BIN, ...args], {
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

describe("main (CLI entrypoint, subprocess)", () => {
  test("answers --help without loading the review flow", () => {
    // Importing the flow, the engine, and the walkthrough renderer costs
    // seconds of module loading. `main.ts` therefore holds only the parsing and
    // the usage text, and reaches `runReview.ts` through a dynamic import.
    // A regression here is someone hoisting that import back to the top.
    const started = Date.now();
    const result = spawnMain(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("--help prints USAGE and exits 0", () => {
    const result = spawnMain(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smithers review");
    expect(result.stdout).toContain("Usage: smithers-review");
    expect(result.stdout).toContain("--help");
  });

  test("--help groups flags and documents env vars and examples", () => {
    const result = spawnMain(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("What to review");
    expect(result.stdout).toContain("Review behavior");
    expect(result.stdout).toContain("Output");
    expect(result.stdout).toContain("Environment");
    expect(result.stdout).toContain("Examples");
    expect(result.stdout).toContain("--quiz <off|auto|on>");
    expect(result.stdout).toContain("--no-verify");
    expect(result.stdout).toContain("--version");
    expect(result.stdout).toContain("SMITHERS_REVIEW_SEAT");
    expect(result.stdout).toContain("SMITHERS_REVIEW_CHEAP_SEAT");
    expect(result.stdout).toContain("ANTHROPIC_API_KEY");
    expect(result.stdout).toContain("OPENAI_API_KEY");
    expect(result.stdout).toContain("SMITHERS_REVIEW_PUBLISH_URL");
    expect(result.stdout).toContain("SMITHERS_REVIEW_PUBLISH_TOKEN");
    expect(result.stdout).toContain("SMITHERS_REVIEW_SUMMARY_PATH");
  });

  test("--version prints the package version and exits 0", async () => {
    const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as { version: string };
    const result = spawnMain(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("bad --quiz value exits 1 with the validation message", () => {
    const result = spawnMain(["--quiz", "nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--quiz must be one of off, auto, on");
  });

  test("-h prints USAGE and exits 0", () => {
    const result = spawnMain(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("smithers review");
    expect(result.stdout).toContain("Usage: smithers-review");
  });

  test("unknown option exits 1 and prints error + USAGE to stderr", () => {
    const result = spawnMain(["--totally-unknown-flag-xyz"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("smithers-review:");
    expect(result.stderr).toContain("Unknown option");
    expect(result.stderr).toContain("Usage: smithers-review");
  });

  test("option missing value exits 1 and prints error + USAGE to stderr", () => {
    const result = spawnMain(["--from"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("smithers-review:");
    expect(result.stderr).toContain("--from requires a value");
    expect(result.stderr).toContain("Usage: smithers-review");
  });
});

describe("parseQuizColumn", () => {
  test("non-string values return null", () => {
    expect(parseQuizColumn(null)).toBeNull();
    expect(parseQuizColumn(undefined)).toBeNull();
    expect(parseQuizColumn(42)).toBeNull();
    expect(parseQuizColumn({})).toBeNull();
    expect(parseQuizColumn("")).toBeNull();
    expect(parseQuizColumn("   ")).toBeNull();
  });

  test("invalid JSON returns null", () => {
    expect(parseQuizColumn("{not json")).toBeNull();
  });

  test("JSON failing the quiz schema returns null", () => {
    expect(parseQuizColumn(JSON.stringify({ impact: "very bad", questions: "none" }))).toBeNull();
    expect(parseQuizColumn(JSON.stringify({ questions: [{ question: 42 }] }))).toBeNull();
  });

  test("valid quiz JSON parses", () => {
    const quiz = {
      impact: { level: "high", reasons: [{ signal: "security-sensitive path (auth)", path: "src/auth.ts" }] },
      questions: [
        {
          question: "What breaks when the token is empty?",
          options: ["A bypass", "Nothing"],
          correctIndex: 0,
          explanation: "The guard returns early.",
          path: "src/auth.ts",
        },
      ],
    };
    const parsed = parseQuizColumn(JSON.stringify(quiz));
    expect(parsed).not.toBeNull();
    expect(parsed!.impact.level).toBe("high");
    expect(parsed!.questions).toHaveLength(1);
  });
});

describe("runReviewCli", () => {
  test("custom command name is reflected in help", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (line?: unknown) => {
        logs.push(String(line ?? ""));
      };
      await runReviewCli(["--help"], { command: "smithers review" });
    } finally {
      console.log = originalLog;
    }
    expect(logs.join("\n")).toContain("Usage: smithers review [repo] [options]");
    expect(logs.join("\n")).toContain("smithers review --from main --to HEAD");
  });
});

/**
 * A review that produced no findings because every file review errored must not
 * report "findings: none" — that is the exact wording of a clean review, so a
 * CI credential expiry reads as a passing review to anyone scanning the log.
 */
describe("buildRunSummaryLine", () => {
  const base = { filesChanged: 9, elapsed: "17s", breakdown: "none", reviewFailed: false, failedFileReviews: 0 };

  test("a clean review reports findings: none", () => {
    expect(buildRunSummaryLine(base)).toBe("reviewed 9 files in 17s — findings: none");
  });

  test("a review with findings reports the severity breakdown", () => {
    expect(buildRunSummaryLine({ ...base, breakdown: "1 major, 2 minor" })).toBe(
      "reviewed 9 files in 17s — findings: 1 major, 2 minor",
    );
  });

  test("a failed review says so instead of claiming no findings", () => {
    const line = buildRunSummaryLine({ ...base, reviewFailed: true, failedFileReviews: 5 });
    expect(line).toBe(
      "reviewed 9 files in 17s — review did not complete (5 file reviews failed); findings unavailable",
    );
    expect(line).not.toContain("findings: none");
  });

  test("a failed review with no per-file detail still refuses to claim no findings", () => {
    const line = buildRunSummaryLine({ ...base, reviewFailed: true });
    expect(line).toBe("reviewed 9 files in 17s — review did not complete; findings unavailable");
    expect(line).not.toContain("findings: none");
  });

  test("a partial review reports the breakdown AND that coverage is incomplete", () => {
    expect(buildRunSummaryLine({ ...base, failedFileReviews: 1 })).toBe(
      "reviewed 9 files in 17s — findings: none (incomplete: 1 file review failed)",
    );
  });

  test("singular file count reads naturally", () => {
    expect(buildRunSummaryLine({ ...base, filesChanged: 1 })).toBe("reviewed 1 file in 17s — findings: none");
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-main-e2e-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  mkdirSync(dirname(join(dir, "src/app.ts")), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), "export const value = 1;\n");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  writeFileSync(join(dir, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
  return dir;
}

describe("main (agentless full run, subprocess)", () => {
  test("runs the workflow, reports progress + summary, tolerates publish failure, writes the summary file", () => {
    const repo = tempRepo();
    const work = mkdtempSync(join(tmpdir(), "review-main-work-"));
    tempDirs.push(work);
    const outPath = join(work, "walkthrough.html");
    const summaryPath = join(work, "summary.json");

    const result = spawnMain(
      [repo, "--no-review", "--no-narrate", "--publish", "--out", outPath, "--db", join(work, "review.db")],
      {
        // A port nothing listens on: publish must fail without failing the run.
        SMITHERS_REVIEW_PUBLISH_URL: "http://127.0.0.1:9",
        SMITHERS_REVIEW_PUBLISH_TOKEN: "srs_test",
        SMITHERS_REVIEW_SUMMARY_PATH: summaryPath,
        GITHUB_ACTIONS: "true",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(result.stderr).toContain("findings: none");
    expect(result.stderr).toContain("publish failed (non-fatal)");
    expect(result.stdout).toContain("::warning::smithers review publish failed");
    expect(result.stdout).toContain(`Walkthrough: ${outPath}`);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      files: number;
      findings: number;
      publishError: string;
      severity: Record<string, number>;
      impact: string;
      questions: number;
    };
    expect(summary.files).toBe(1);
    expect(summary.findings).toBe(0);
    expect(summary.publishError).not.toBe("");
    expect(summary.severity).toEqual({ critical: 0, major: 0, minor: 0, info: 0 });
    expect(summary.impact).toBe("low");
    expect(summary.questions).toBe(0);
  }, 120_000);
});
