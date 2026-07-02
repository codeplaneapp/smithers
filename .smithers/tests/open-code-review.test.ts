import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNativeReviewPrompt,
  diffStatus,
  effectivePath,
  finalizeNativeReview,
  globMatch,
  loadDiffs,
  previewOpenCodeReview,
  validateReviewInput,
  type NativeReviewFileResult,
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
    concurrency: 8,
    timeout: 10,
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

  test("review mode validation rejects ambiguous refs", () => {
    expect(() => validateReviewInput(input(".", { from: "main" }))).toThrow("--to is required");
    expect(() => validateReviewInput(input(".", { from: "main", to: "feature", commit: "abc" }))).toThrow("Only one review mode");
  });

  test("native review prompt includes reviewable diffs and excludes default filtered diffs", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");

    const preview = await previewOpenCodeReview(input(repo, { background: "security pass" }));
    const prepared = await buildNativeReviewPrompt(input(repo, { background: "security pass" }), preview);

    expect(prepared.shouldReview).toBe(true);
    expect(prepared.reviewableFiles).toBe(1);
    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0].id).toMatch(/^review-file-1-src-app-ts$/);
    expect(prepared.files[0].prompt).toContain("OpenCodeReview per-file review flow");
    expect(prepared.files[0].prompt).toContain("Requirement background: security pass");
    expect(prepared.files[0].prompt).toContain("Current file path: src/app.ts");
    expect(prepared.files[0].prompt).not.toContain("Current file path: src/app.test.ts");
    expect(prepared.files[0].prompt).toContain("Return only structured data matching the Smithers output schema.");
  });

  test("native review prompt creates one Smithers review task per reviewable file", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/other.ts"), "export const other = 3;\n");

    const reviewInput = input(repo);
    const preview = await previewOpenCodeReview(reviewInput);
    const prepared = await buildNativeReviewPrompt(reviewInput, preview);

    expect(prepared.files.map((file) => file.path).sort()).toEqual(["src/app.ts", "src/other.ts"]);
    expect(prepared.files.find((file) => file.path === "src/app.ts")?.prompt).toContain("ADDED   src/other.ts");
    expect(prepared.files.find((file) => file.path === "src/other.ts")?.prompt).toContain("MODIFIED   src/app.ts");
  });

  test("native review finalizer aggregates per-file outputs, injects paths, resolves lines, and drops out-of-scope comments", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/other.ts"), "export const other = 3;\n");
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");

    const reviewInput = input(repo);
    const preview = await previewOpenCodeReview(reviewInput);
    const prepared = await buildNativeReviewPrompt(reviewInput, preview);
    const appFile = prepared.files.find((file) => file.path === "src/app.ts")!;
    const otherFile = prepared.files.find((file) => file.path === "src/other.ts")!;
    const fileResults: NativeReviewFileResult[] = [
      {
        file: appFile,
        output: {
          status: "success",
          message: "",
          summary: { filesReviewed: 1, comments: 2, totalTokens: 123, inputTokens: 100, outputTokens: 23, elapsed: "1s" },
          comments: [
            {
              path: "",
              content: "Check this.",
              suggestionCode: "safe();",
              existingCode: "export const next = 2;",
              startLine: 0,
              endLine: 0,
              thinking: "",
              severity: "minor",
              category: "correctness",
              confidence: "confirmed",
            },
            {
              path: "src/app.test.ts",
              content: "Out of scope.",
              suggestionCode: "",
              existingCode: "",
              startLine: 1,
              endLine: 1,
              thinking: "",
              severity: "info",
              category: "tests",
              confidence: "plausible",
            },
          ],
          warnings: [],
        },
      },
      {
        file: otherFile,
        output: {
          status: "success",
          message: "",
          summary: { filesReviewed: 1, comments: 0, totalTokens: 7, inputTokens: 4, outputTokens: 3, elapsed: "1s" },
          comments: [],
          warnings: [],
        },
      },
    ];
    const finalized = finalizeNativeReview(reviewInput, prepared, preview, fileResults);

    expect(finalized.status).toBe("completed_with_warnings");
    expect(finalized.summary?.filesReviewed).toBe(2);
    expect(finalized.summary?.totalTokens).toBe(130);
    expect(finalized.comments).toHaveLength(1);
    expect(finalized.comments[0].path).toBe("src/app.ts");
    expect(finalized.comments[0].suggestionCode).toBe("safe();");
    expect(finalized.comments[0].startLine).toBe(2);
    expect(finalized.comments[0].endLine).toBe(2);
    expect(finalized.warnings[0].type).toBe("out_of_scope_comment");
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

  test("loadDiffs exposes full workspace diff records, including review-excluded files", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");

    const diffs = await loadDiffs(repo, input(repo));
    const byPath = new Map(diffs.map((diff) => [effectivePath(diff), diff]));

    const app = byPath.get("src/app.ts")!;
    expect(diffStatus(app)).toBe("modified");
    expect(app.insertions).toBe(1);
    expect(app.diff).toContain("+export const next = 2;");

    const test = byPath.get("src/app.test.ts")!;
    expect(diffStatus(test)).toBe("added");
    expect(test.diff).toContain("+test('x', () => {});");
  });
});
