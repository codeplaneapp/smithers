import { describe, expect, test } from "bun:test";
import type { Diff, DiffFile } from "../src/diff";
import {
  binaryBodyLabel,
  byteCountString,
  detectBinary,
  diffTotals,
  fileStatus,
  initialExpanded,
  isLargeDiff,
  LARGE_BYTE_LIMIT,
  LARGE_FILE_COUNT,
  PAGINATE_THRESHOLD,
  PAGINATE_VISIBLE,
  parseHunks,
  parseUnifiedFile,
  statusLetter,
  totalBytes,
} from "../src/diff-paginate";

/**
 * The pure diff domain, driven directly. Eight of its exports had no test of
 * their own: their coverage was whatever `DiffHunks` happened to touch while
 * rendering, which is not the same as a contract.
 */

const file = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/a.ts",
  add: 0,
  del: 0,
  lines: [],
  ...overrides,
});

const diff = (files: DiffFile[]): Diff => ({ files });

describe("parseHunks line accounting", () => {
  test("a newline-terminated patch produces no phantom trailing context row", () => {
    // The split sentinel: "…\n".split(/\r?\n/) ends in "", which the blank
    // context branch used to render as a real line and count on both sides.
    const parsed = parseHunks("@@ -1,1 +1,1 @@\n-old\n+new\n");
    expect(parsed.lines.map((line) => line.text)).toEqual(["@@ -1,1 +1,1 @@", "old", "new"]);
    expect({ add: parsed.add, del: parsed.del }).toEqual({ add: 1, del: 1 });
  });

  test("a patch with no trailing newline parses identically", () => {
    expect(parseHunks("@@ -1,1 +1,1 @@\n-old\n+new")).toEqual(parseHunks("@@ -1,1 +1,1 @@\n-old\n+new\n"));
  });

  test("CRLF termination parses identically to LF", () => {
    expect(parseHunks("@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n")).toEqual(parseHunks("@@ -1,1 +1,1 @@\n-old\n+new\n"));
  });

  test("a blank context line inside the patch body is still a real line", () => {
    const parsed = parseHunks("@@ -1,3 +1,3 @@\n a\n\n b\n");
    expect(parsed.lines.map((line) => ({ kind: line.kind, ln: line.ln, text: line.text }))).toEqual([
      { kind: "context", ln: undefined, text: "@@ -1,3 +1,3 @@" },
      { kind: "context", ln: 1, text: "a" },
      { kind: "context", ln: 2, text: "" },
      { kind: "context", ln: 3, text: "b" },
    ]);
  });

  test("the no-newline marker is dropped without consuming a line number", () => {
    const parsed = parseHunks("@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n");
    expect(parsed.lines.map((line) => line.text)).toEqual(["@@ -1,1 +1,1 @@", "old", "new"]);
  });

  test("a second hunk restarts both line counters from its own header", () => {
    const parsed = parseHunks("@@ -1,1 +1,1 @@\n+one\n@@ -10,1 +20,1 @@\n+two\n");
    const adds = parsed.lines.filter((line) => line.kind === "add");
    expect(adds.map((line) => line.ln)).toEqual([1, 20]);
  });

  test("partial reports a patch that mentions hunks but parses none", () => {
    expect(parseHunks("@@ truncated").partial).toBe(true);
    expect(parseHunks("@@ -1,1 +1,1 @@\n+x\n").partial).toBe(false);
  });
});

describe("path parsing", () => {
  test("an unquoted path with spaces parses", () => {
    expect(parseUnifiedFile("diff --git a/my file.ts b/my file.ts\n@@ -1,1 +1,1 @@\n+x\n").path).toBe("my file.ts");
  });

  test("a Git-quoted path with octal-escaped UTF-8 parses back to the real name", () => {
    const patch = 'diff --git "a/caf\\303\\251 name.ts" "b/caf\\303\\251 name.ts"\n@@ -1,1 +1,1 @@\n+x\n';
    expect(parseUnifiedFile(patch).path).toBe("café name.ts");
  });

  test("a quoted +++ header alone still yields the path", () => {
    const patch = '--- /dev/null\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1,1 @@\n+x\n';
    expect(parseUnifiedFile(patch).path).toBe("café.ts");
  });

  test("a quoted rename records both sides", () => {
    const patch = 'diff --git "a/caf\\303\\251.ts" "b/th\\303\\251.ts"\n'
      + 'rename from "caf\\303\\251.ts"\nrename to "th\\303\\251.ts"\n';
    const parsed = parseUnifiedFile(patch);
    expect({ path: parsed.path, oldPath: parsed.oldPath, status: parsed.status }).toEqual({
      path: "thé.ts",
      oldPath: "café.ts",
      status: "renamed",
    });
  });

  test("an escaped quote and backslash inside a quoted path survive", () => {
    const patch = 'diff --git "a/we\\"ird\\\\name.ts" "b/we\\"ird\\\\name.ts"\n@@ -1,1 +1,1 @@\n+x\n';
    expect(parseUnifiedFile(patch).path).toBe('we"ird\\name.ts');
  });
});

describe("detectBinary agrees with parseUnifiedFile", () => {
  test("an ADDED line that happens to contain a binary marker is not a binary file", () => {
    const patch = "diff --git a/notes.md b/notes.md\n"
      + "@@ -0,0 +2,2 @@\n"
      + "+GIT binary patch\n"
      + "+Binary files are handled by git\n";
    const parsed = parseUnifiedFile(patch);
    expect(parsed.isBinary).toBeUndefined();
    expect(parsed.add).toBe(2);
    expect(detectBinary(parsed)).toBe(false);
  });

  test("a DELETED line containing a marker is not a binary file either", () => {
    const patch = "diff --git a/notes.md b/notes.md\n@@ -1,1 +0,0 @@\n-Binary files differ, allegedly\n";
    const parsed = parseUnifiedFile(patch);
    expect(detectBinary(parsed)).toBe(false);
  });

  test("a real GIT binary patch is binary on both paths", () => {
    const patch = "diff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 12\n";
    const parsed = parseUnifiedFile(patch);
    expect(parsed.isBinary).toBe(true);
    expect(detectBinary(parsed)).toBe(true);
  });

  test("a Binary files summary is binary on both paths", () => {
    const patch = "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    const parsed = parseUnifiedFile(patch);
    expect(parsed.isBinary).toBe(true);
    expect(detectBinary(parsed)).toBe(true);
  });

  test("an explicit isBinary flag still wins", () => {
    expect(detectBinary(file({ isBinary: true }))).toBe(true);
  });
});

describe("status helpers", () => {
  test("fileStatus defaults to modified and statusLetter covers every status", () => {
    expect(fileStatus(file())).toBe("modified");
    expect(statusLetter(file())).toBe("M");
    expect(
      (["added", "modified", "deleted", "renamed", "unknown"] as const).map((status) =>
        statusLetter(file({ status }))
      ),
    ).toEqual(["A", "M", "D", "R", "?"]);
  });
});

describe("byteCountString boundaries", () => {
  test("scales at each unit boundary", () => {
    expect([0, 1023, 1024, 1_048_575, 1_048_576].map(byteCountString)).toEqual([
      "0 B",
      "1023 B",
      "1.0 KB",
      "1024.0 KB",
      "1.0 MB",
    ]);
  });

  test("a negative or non-finite size reports an unknown size instead of nonsense", () => {
    expect([-5, Number.NaN, Number.POSITIVE_INFINITY].map(byteCountString)).toEqual([
      "unknown size",
      "unknown size",
      "unknown size",
    ]);
  });

  test("binaryBodyLabel names the size only when it has one", () => {
    expect(binaryBodyLabel(file({ sizeBytes: 2048 }))).toBe("Binary file (2.0 KB)");
    expect(binaryBodyLabel(file())).toBe("Binary file");
    expect(binaryBodyLabel(file({ sizeBytes: Number.NaN }))).toBe("Binary file (unknown size)");
  });
});

describe("diff-level aggregates", () => {
  test("totalBytes and diffTotals sum what the files declare, missing sizes included", () => {
    const subject = diff([
      file({ path: "a.ts", add: 3, del: 1, sizeBytes: 10 }),
      file({ path: "b.ts", add: 2, del: 0 }),
    ]);
    expect(totalBytes(subject)).toBe(10);
    expect(diffTotals(subject)).toEqual({ files: 2, add: 5, del: 1 });
  });

  test("isLargeDiff triggers strictly above each bound", () => {
    const byCount = (count: number) =>
      diff(Array.from({ length: count }, (_, index) => file({ path: `f${index}.ts` })));
    expect(isLargeDiff(byCount(LARGE_FILE_COUNT))).toBe(false);
    expect(isLargeDiff(byCount(LARGE_FILE_COUNT + 1))).toBe(true);
    expect(isLargeDiff(diff([file({ sizeBytes: LARGE_BYTE_LIMIT })]))).toBe(false);
    expect(isLargeDiff(diff([file({ sizeBytes: LARGE_BYTE_LIMIT + 1 })]))).toBe(true);
  });

  test("initialExpanded opens every file at three, the first three at four, none when large", () => {
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `f${index}.ts`);
    const byPaths = (names: string[]) => diff(names.map((path) => file({ path })));
    expect(initialExpanded(byPaths(paths(3)))).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
    expect(initialExpanded(byPaths(paths(4)))).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
    expect(initialExpanded(diff([file({ sizeBytes: LARGE_BYTE_LIMIT + 1 })]))).toEqual([]);
  });

  test("the pagination budget is the documented pair", () => {
    expect(PAGINATE_VISIBLE).toBeLessThan(PAGINATE_THRESHOLD);
  });
});
