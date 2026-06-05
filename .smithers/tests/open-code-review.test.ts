import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildReviewArgs,
  globMatch,
  parseReviewJson,
  previewOpenCodeReview,
  validateReviewInput,
  type OpenCodeReviewInput,
} from "../lib/open-code-review";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ocr-smithers-"));
  tempDirs.push(dir);
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  write(join(dir, "src/app.ts"), "export const value = 1;\n");
  write(join(dir, "src/keep.go"), "package src\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "initial"], dir);
  return dir;
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

function input(repo: string, overrides: Partial<OpenCodeReviewInput> = {}): OpenCodeReviewInput {
  return {
    repo,
    from: "",
    to: "",
    commit: "",
    background: "",
    rule: "",
    tools: "",
    concurrency: 8,
    timeout: 10,
    maxTools: 0,
    ocrBin: "ocr",
    runReview: true,
    ...overrides,
  };
}

describe("OpenCodeReview compatibility helpers", () => {
  test("glob matching follows OCR brace and doublestar cases", () => {
    expect(globMatch("**/*.spec.{js,jsx,ts,tsx}", "src/app.spec.ts")).toBe(true);
    expect(globMatch("**/*_test.go", "handler_test.go")).toBe(true);
    expect(globMatch("**/*_test.go", "pkg/handler_test.go")).toBe(true);
    expect(globMatch("vendor/**", "vendor/pkg/main.go")).toBe(true);
    expect(globMatch("vendor/**", "src/vendorized/main.go")).toBe(false);
  });

  test("review args mirror OCR review flags and validation", () => {
    expect(() => validateReviewInput(input(".", { from: "main" }))).toThrow("--to is required");
    expect(() => validateReviewInput(input(".", { from: "main", to: "feature", commit: "abc" }))).toThrow("Only one review mode");
    expect(buildReviewArgs(input("/repo", { from: "main", to: "feature", background: "security pass" }), false)).toEqual([
      "review",
      "--repo",
      "/repo",
      "--from",
      "main",
      "--to",
      "feature",
      "--background",
      "security pass",
      "--concurrency",
      "8",
      "--timeout",
      "10",
      "--format",
      "json",
      "--audience",
      "agent",
    ]);
  });

  test("parses OCR JSON output with snake_case fields", () => {
    const parsed = parseReviewJson(JSON.stringify({
      status: "success",
      summary: {
        files_reviewed: 1,
        comments: 1,
        total_tokens: 123,
        input_tokens: 100,
        output_tokens: 23,
        elapsed: "1s",
      },
      comments: [
        {
          path: "src/app.ts",
          content: "Check this.",
          suggestion_code: "safe();",
          existing_code: "unsafe();",
          start_line: 4,
          end_line: 4,
        },
      ],
    }));
    expect(parsed.summary?.filesReviewed).toBe(1);
    expect(parsed.summary?.totalTokens).toBe(123);
    expect(parsed.comments[0].suggestionCode).toBe("safe();");
    expect(parsed.comments[0].existingCode).toBe("unsafe();");
    expect(parsed.comments[0].startLine).toBe(4);
  });

  test("workspace preview matches OCR source, test, and extension filtering", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");
    write(join(repo, "docs/readme.md"), "# Notes\n");

    const preview = await previewOpenCodeReview(input(repo));
    const byPath = new Map(preview.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("src/app.ts")?.willReview).toBe(true);
    expect(byPath.get("src/app.test.ts")?.willReview).toBe(false);
    expect(byPath.get("src/app.test.ts")?.excludeReason).toBe("default_path");
    expect(byPath.get("docs/readme.md")?.willReview).toBe(false);
    expect(byPath.get("docs/readme.md")?.excludeReason).toBe("unsupported_ext");
    expect(preview.reviewableCount).toBe(1);
    expect(preview.excludedCount).toBe(2);
  });

  test("custom include filter bypasses OCR default path exclusions", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");
    write(join(repo, "rules.json"), JSON.stringify({ include: ["src/**/*.ts"] }));

    const preview = await previewOpenCodeReview(input(repo, { rule: join(repo, "rules.json") }));
    const testFile = preview.entries.find((entry) => entry.path === "src/app.test.ts");

    expect(testFile?.willReview).toBe(true);
    expect(testFile?.excludeReason).toBe("");
  });

  test("custom exclude filter wins over supported extension", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 2;\n");
    write(join(repo, "rules.json"), JSON.stringify({ exclude: ["src/**"] }));

    const preview = await previewOpenCodeReview(input(repo, { rule: join(repo, "rules.json") }));
    const app = preview.entries.find((entry) => entry.path === "src/app.ts");

    expect(app?.willReview).toBe(false);
    expect(app?.excludeReason).toBe("user_exclude");
  });
});
