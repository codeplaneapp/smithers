import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuizColumn, runReviewCli, writeReviewSummary } from "../../src/cli/main";

const MAIN_TS = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnMain(args: string[], env?: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", MAIN_TS, ...args], {
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
    expect(result.stdout).toContain("SMITHERS_REVIEW_ENGINE");
    expect(result.stdout).toContain("SMITHERS_REVIEW_MODEL");
    expect(result.stdout).toContain("CODEX_HOME");
    expect(result.stdout).toContain("ANTHROPIC_BASE_URL");
    expect(result.stdout).toContain("ANTHROPIC_API_KEY");
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

describe("review summary output policy", () => {
  test("writes bounded private JSON and refuses a final symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-summary-policy-"));
    tempDirs.push(dir);
    const summaryPath = join(dir, "summary.json");
    writeReviewSummary(summaryPath, { status: "finished", findings: 2 });
    expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toEqual({ status: "finished", findings: 2 });
    if (process.platform !== "win32") expect(lstatSync(summaryPath).mode & 0o077).toBe(0);
    expect(() => writeReviewSummary(join(dir, "oversized.json"), "x".repeat(64 * 1024))).toThrow(/64 KB/);

    const target = join(dir, "target.json");
    const link = join(dir, "summary-link.json");
    writeFileSync(target, "keep-target");
    symlinkSync(target, link);
    expect(() => writeReviewSummary(link, { replace: true })).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep-target");
  });
});

describe("main (agentless full run, subprocess)", () => {
  test(
    "runs the workflow, reports progress + summary, tolerates publish failure, writes the summary file",
    () => {
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
      expect(result.stderr).toContain("walkthrough: rendering HTML…");
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
    },
    120_000,
  );
});
