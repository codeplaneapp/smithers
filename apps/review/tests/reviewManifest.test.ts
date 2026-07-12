import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { serializeValidatedReviewArtifact } from "../action/src/runAction";
import { listPullRequestFiles } from "../src/github/listPullRequestFiles";
import { loadDiffs, normalizeOpenCodeReviewInput } from "../src/workflow/openCodeReview";
import {
  compareReviewPaths,
  deriveReviewManifestCapabilities,
  generateReviewManifest,
  parseReviewNameStatus,
  parseReviewManifest,
  readProtectedReviewManifest,
  writeProtectedReviewManifest,
} from "../src/reviewManifest";
import type { ReviewManifestGitRuntime } from "../src/reviewManifest";

const add = (path: string, patch: string, additions = 1) => JSON.stringify({ oldPath: path, newPath: path, filename: path, status: "A", additions, deletions: 0, binary: false, patch, newMode: "100644" });
const SHA1_ZERO = "0".repeat(40);
const SHA1_ONE = "1".repeat(40);
const SHA1_TWO = "2".repeat(40);

function repository(prefix = "review-manifest-") {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review test"]);
  return { repo, git };
}

const OID_BASE = "a".repeat(40);
const OID_HEAD = "b".repeat(40);
const OID_OLD = "c".repeat(40);
const OID_NEW = "d".repeat(40);
const OID_EMPTY = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function addedNameStatus(count: number): Buffer {
  return Buffer.from(Array.from({ length: count }, (_, index) => `A\0f${index.toString().padStart(4, "0")}\0`).join(""));
}

function singleFileRuntime(options: {
  status: "A" | "M";
  oldBody?: Buffer;
  newBody: Buffer;
  onDiff?: (maxBuffer: number) => Uint8Array;
  calls?: string[][];
}): ReviewManifestGitRuntime {
  const oldBody = options.oldBody;
  const ids = options.status === "A" ? [OID_NEW] : [OID_OLD, OID_NEW];
  return {
    run(args, command) {
      const argv = [...args];
      options.calls?.push(argv);
      if (argv[0] === "merge-base") return Buffer.from(`${OID_BASE}\n`);
      if (argv.includes("--name-status")) return Buffer.from(`${options.status}\0f\0`);
      if (argv.includes("ls-tree")) {
        const revision = argv[argv.indexOf("--full-tree") + 1];
        if (revision === OID_BASE && oldBody) return Buffer.from(`100644 blob ${OID_OLD}\tf\0`);
        if (revision === OID_HEAD) return Buffer.from(`100644 blob ${OID_NEW}\tf\0`);
        return Buffer.alloc(0);
      }
      if (argv[0] === "cat-file" && argv[1].startsWith("--batch-check=")) {
        return Buffer.from(ids.map((id) => `${id} blob ${id === OID_OLD ? oldBody!.byteLength : options.newBody.byteLength}\n`).join(""));
      }
      if (argv[0] === "cat-file" && argv[1] === "--batch") {
        return Buffer.concat(ids.map((id) => {
          const body = id === OID_OLD ? oldBody! : options.newBody;
          return Buffer.concat([Buffer.from(`${id} blob ${body.byteLength}\n`), body, Buffer.from("\n")]);
        }));
      }
      if (argv.includes("--full-index") && options.onDiff) return options.onDiff(command.maxBuffer);
      throw new Error(`unexpected Git command: ${argv.join(" ")}`);
    },
  };
}

describe("immutable review manifest canonical patches", () => {
  test("parses the bounded NUL protocol in raw-byte order at the exact file limit", () => {
    expect(parseReviewNameStatus(addedNameStatus(3_000))).toHaveLength(3_000);
    expect(() => parseReviewNameStatus(addedNameStatus(3_001))).toThrow(/3,000/);

    // JavaScript UTF-16 ordering puts U+10000 before U+E000; Git raw UTF-8
    // ordering does the opposite. The immutable protocol follows Git bytes.
    const byteOrdered = Buffer.from(`A\0\uE000\0A\0\u{10000}\0`);
    expect(parseReviewNameStatus(byteOrdered).map((item) => item.filename)).toEqual(["\uE000", "\u{10000}"]);
    expect(() => parseReviewNameStatus(Buffer.from(`A\0\u{10000}\0A\0\uE000\0`))).toThrow(/noncanonical/);
    expect(() => parseReviewNameStatus(Buffer.from([0x41, 0, 0xff, 0]))).toThrow(/UTF-8/);
    expect(() => parseReviewNameStatus(Buffer.from("A\0f"))).toThrow(/terminal-NUL/);
    expect(() => parseReviewNameStatus(Buffer.from("A\0f\0\0"))).toThrow(/empty token/);

    const hostile = ["-dash", "back\\slash", "line\nname", "space name"].sort(compareReviewPaths);
    const encoded = Buffer.from(hostile.map((name) => `A\0${name}\0`).join(""));
    expect(parseReviewNameStatus(encoded).map((item) => item.filename)).toEqual(hostile);
    expect(() => parseReviewManifest(JSON.stringify({
      oldPath: "bad\ud800", newPath: "bad\ud800", filename: "bad\ud800", status: "A",
      additions: 0, deletions: 0, binary: true, newMode: "100644",
    }))).toThrow(/invalid fields/);
  });

  test("rejects the 3,001st file before any tree, blob, or patch command", () => {
    const calls: string[][] = [];
    const runtime: ReviewManifestGitRuntime = {
      run(args) {
        const argv = [...args];
        calls.push(argv);
        if (argv[0] === "merge-base") return Buffer.from(`${OID_BASE}\n`);
        if (argv.includes("--name-status")) return addedNameStatus(3_001);
        throw new Error("generator crossed the name-status resource gate");
      },
    };
    expect(() => generateReviewManifest("unused", OID_BASE, OID_HEAD, runtime)).toThrow(/3,000/);
    expect(calls).toHaveLength(2);
    expect(calls.some((args) => args.includes("ls-tree") || args[0] === "cat-file" || args.includes("--full-index"))).toBe(false);
  });

  test("successfully generates the exact 3,000-file boundary with bounded commands", () => {
    let diffCalls = 0;
    const runtime: ReviewManifestGitRuntime = {
      run(args, command) {
        const argv = [...args];
        if (argv[0] === "merge-base") return Buffer.from(`${OID_BASE}\n`);
        if (argv.includes("--name-status")) return addedNameStatus(3_000);
        if (argv.includes("ls-tree")) {
          const revision = argv[argv.indexOf("--full-tree") + 1];
          if (revision === OID_BASE) return Buffer.alloc(0);
          const paths = argv.slice(argv.lastIndexOf("--") + 1);
          return Buffer.from(paths.map((path) => `100644 blob ${OID_EMPTY}\t${path}\0`).join(""));
        }
        if (argv[0] === "cat-file" && argv[1].startsWith("--batch-check=")) return Buffer.from(`${OID_EMPTY} blob 0\n`);
        if (argv[0] === "cat-file" && argv[1] === "--batch") return Buffer.from(`${OID_EMPTY} blob 0\n\n`);
        if (argv.includes("--full-index")) {
          diffCalls += 1;
          expect(command.maxBuffer).toBe(8 * 1024 * 1024);
          const path = argv.at(-1)!;
          return Buffer.from(`diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${SHA1_ZERO}..${OID_EMPTY}\n`);
        }
        throw new Error(`unexpected Git command: ${argv.join(" ")}`);
      },
    };
    const records = parseReviewManifest(generateReviewManifest("unused", OID_BASE, OID_HEAD, runtime));
    expect(records).toHaveLength(3_000);
    expect(diffCalls).toBe(0);
  });

  test("checks oversized blob metadata before materializing any object body", () => {
    const calls: string[][] = [];
    const runtime = singleFileRuntime({ status: "A", newBody: Buffer.alloc(8 * 1024 * 1024 + 1), calls });
    expect(() => generateReviewManifest("unused", OID_BASE, OID_HEAD, runtime)).toThrow(/per-blob limit/);
    expect(calls.some((args) => args[0] === "cat-file" && args[1] === "--batch")).toBe(false);
    expect(calls.some((args) => args.includes("--full-index"))).toBe(false);
  });

  test("enforces the per-file patch buffer even when a runtime ignores it", () => {
    let observedLimit = 0;
    const runtime = singleFileRuntime({
      status: "M",
      oldBody: Buffer.from("old\n"),
      newBody: Buffer.from("new\n"),
      onDiff(maxBuffer) {
        observedLimit = maxBuffer;
        return Buffer.alloc(maxBuffer + 1);
      },
    });
    expect(() => generateReviewManifest("unused", OID_BASE, OID_HEAD, runtime)).toThrow(/command boundary/);
    expect(observedLimit).toBe(8 * 1024 * 1024);
  });

  test("keeps header-shaped hunk content structural and rejects noncanonical hunks", () => {
    const patch = `diff --git a/f b/f\nnew file mode 100644\nindex ${"0".repeat(40)}..${"1".repeat(40)}\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+-- value\n+++ value\n`;
    const [record] = parseReviewManifest(add("f", patch, 2));
    expect(deriveReviewManifestCapabilities(record).rightLines).toEqual(new Set([1, 2]));
    expect(() => parseReviewManifest(add("f", patch.replace("+1,2", "+1,1"), 2))).toThrow();
    expect(() => parseReviewManifest(add("f", patch.slice(0, -1), 2))).toThrow();
  });

  test("accepts canonical empty additions and refuses patchless nonbinary additions", () => {
    const empty = `diff --git a/e b/e\nnew file mode 100644\nindex ${"0".repeat(40)}..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n`;
    const [record] = parseReviewManifest(JSON.stringify({ oldPath: "e", newPath: "e", filename: "e", status: "A", additions: 0, deletions: 0, binary: false, patch: empty, newMode: "100644" }));
    expect(deriveReviewManifestCapabilities(record).rightLines).toEqual(new Set());
    expect(() => parseReviewManifest(JSON.stringify({ oldPath: "e", newPath: "e", filename: "e", status: "A", additions: 0, deletions: 0, binary: false }))).toThrow();
  });

  test("real Git regular-to-symlink transition grants only new-side lines", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-manifest-"));
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
      git(["init", "-q"]); git(["config", "user.email", "test@example.test"]); git(["config", "user.name", "Test"]);
      writeFileSync(join(repo, "f"), "old\n"); git(["add", "."]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      rmSync(join(repo, "f")); symlinkSync("target", join(repo, "f")); git(["add", "-A"]); git(["commit", "-qm", "type"]); const head = git(["rev-parse", "HEAD"]);
      const [record] = parseReviewManifest(generateReviewManifest(repo, base, head));
      expect(record).toMatchObject({ status: "T", oldMode: "100644", newMode: "120000", additions: 1, deletions: 1 });
      expect(deriveReviewManifestCapabilities(record).rightLines).toEqual(new Set([1]));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("tracks no-final-newline sides and rejects noncanonical ranges and trailing records", () => {
    const preamble = `diff --git a/f b/f\nindex ${SHA1_ONE}..${SHA1_TWO} 100644\n--- a/f\n+++ b/f\n`;
    const manifest = (patch: string, additions: number, deletions: number) => JSON.stringify({
      oldPath: "f", newPath: "f", filename: "f", status: "M", additions, deletions, binary: false,
      patch, oldMode: "100644", newMode: "100644",
    });
    const both = `${preamble}@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`;
    expect(deriveReviewManifestCapabilities(parseReviewManifest(manifest(both, 1, 1))[0]).rightLines).toEqual(new Set([1]));
    const shared = `${preamble}@@ -1,2 +1,2 @@\n-old\n+new\n common\n\\ No newline at end of file\n`;
    expect(deriveReviewManifestCapabilities(parseReviewManifest(manifest(shared, 1, 1))[0]).rightLines).toEqual(new Set([1, 2]));
    expect(() => parseReviewManifest(manifest(`${both}\\ No newline at end of file\n`, 1, 1))).toThrow();
    expect(() => parseReviewManifest(manifest(`${preamble}@@ -1,2 +1,2 @@\n common\n\\ No newline at end of file\n-old\n+new\n`, 1, 1))).toThrow();
    expect(() => parseReviewManifest(manifest(both.replace("@@ -1 +1", "@@ -01 +1"), 1, 1))).toThrow();
    expect(() => parseReviewManifest(manifest(`${preamble}@@ -5 +5 @@\n-old\n+new\n@@ -2 +2 @@\n-old2\n+new2\n`, 2, 2))).toThrow();
    expect(() => parseReviewManifest(manifest(`${both}\n`, 1, 1))).toThrow();
  });

  test("binds empty deletion, status, mode, and index metadata exactly", () => {
    const emptyDelete = `diff --git a/e b/e\ndeleted file mode 100644\nindex e69de29bb2d1d6434b8b29ae775ad8c2e48c5391..${SHA1_ZERO}\n`;
    const record = parseReviewManifest(JSON.stringify({
      oldPath: "e", newPath: "e", filename: "e", status: "D", additions: 0, deletions: 0, binary: false,
      patch: emptyDelete, oldMode: "100644",
    }))[0];
    expect(deriveReviewManifestCapabilities(record).rightLines).toEqual(new Set());
    expect(() => parseReviewManifest(JSON.stringify({ ...record, status: "A" }))).toThrow();
    expect(() => parseReviewManifest(JSON.stringify({ ...record, patch: emptyDelete.replace("deleted file mode", "new file mode") }))).toThrow();
    expect(() => parseReviewManifest(JSON.stringify({ ...record, oldMode: "120000" }))).toThrow();
    expect(() => parseReviewManifest(JSON.stringify({ ...record, status: "U" }))).toThrow();
    expect(() => parseReviewManifest(JSON.stringify({
      oldPath: "sub", newPath: "sub", filename: "sub", status: "A", additions: 0, deletions: 0, binary: false,
      patch: `diff --git a/sub b/sub\nnew file mode 160000\nindex ${SHA1_ZERO}..${SHA1_ONE}\n`, newMode: "160000",
    }))).toThrow();
  });

  test("round-trips pure and edited rename/copy records with chmod variants", () => {
    for (const kind of ["rename", "copy"] as const) {
      for (const edited of [false, true]) {
        for (const chmod of [false, true]) {
          const { repo, git } = repository(`review-${kind}-`);
          try {
            writeFileSync(join(repo, "source file"), Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join(""));
            git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
            if (kind === "rename") renameSync(join(repo, "source file"), join(repo, "dest file"));
            else copyFileSync(join(repo, "source file"), join(repo, "dest file"));
            if (edited) appendFileSync(join(repo, "dest file"), "edited\n");
            if (chmod) chmodSync(join(repo, "dest file"), 0o755);
            git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
            const [item] = parseReviewManifest(generateReviewManifest(repo, base, head));
            expect(item.status[0]).toBe(kind === "rename" ? "R" : "C");
            expect(item.status).toMatch(edited ? /^[RC]0\d{2}$/ : /^[RC]100$/);
            expect(item.oldMode).toBe("100644");
            expect(item.newMode).toBe(chmod ? "100755" : "100644");
            if (edited) expect(deriveReviewManifestCapabilities(item).rightLines.size).toBeGreaterThan(0);
            else expect(deriveReviewManifestCapabilities(item).rightLines.size).toBe(0);
          } finally { rmSync(repo, { recursive: true, force: true }); }
        }
      }
    }
  });

  test("isolates a copy record when its source is also modified", () => {
    for (const editDestination of [false, true]) {
      const { repo, git } = repository("review-copy-modified-source-");
      try {
        writeFileSync(join(repo, "source"), Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join(""));
        git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
        copyFileSync(join(repo, "source"), join(repo, "destination"));
        appendFileSync(join(repo, "source"), "source-only edit\n");
        if (editDestination) appendFileSync(join(repo, "destination"), "destination-only edit\n");
        git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
        const records = parseReviewManifest(generateReviewManifest(repo, base, head));
        expect(records.map((item) => item.filename)).toEqual(["destination", "source"]);
        const copied = records[0];
        expect(copied.status).toMatch(editDestination ? /^C0\d{2}$/ : /^C100$/);
        expect(copied.patch).toContain("copy from source\ncopy to destination\n");
        expect(copied.patch).not.toContain("source-only edit");
        expect(deriveReviewManifestCapabilities(copied).rightLines.size).toBe(editDestination ? 4 : 0);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    }
  });

  test("binds mode-only and text-plus-mode M records", () => {
    for (const edited of [false, true]) {
      const { repo, git } = repository("review-mode-change-");
      try {
        writeFileSync(join(repo, "script"), "line one\nline two\n");
        git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
        chmodSync(join(repo, "script"), 0o755);
        if (edited) appendFileSync(join(repo, "script"), "edited\n");
        git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
        const item = parseReviewManifest(generateReviewManifest(repo, base, head))[0];
        expect(item).toMatchObject({ status: "M", oldMode: "100644", newMode: "100755" });
        if (edited) {
          expect(item.patch).toContain("old mode 100644\nnew mode 100755\n");
          expect(deriveReviewManifestCapabilities(item).rightLines.size).toBeGreaterThan(0);
          expect(() => parseReviewManifest(JSON.stringify({ ...item, newMode: "120000" }))).toThrow();
        } else {
          expect(item.patch).toBeUndefined();
          expect(item.additions + item.deletions).toBe(0);
        }
      } finally { rmSync(repo, { recursive: true, force: true }); }
    }

    const ordinary = JSON.stringify({
      oldPath: "f", newPath: "f", filename: "f", status: "M", additions: 1, deletions: 1, binary: false,
      patch: `diff --git a/f b/f\nindex ${SHA1_ONE}..${SHA1_TWO}\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n`,
      oldMode: "100644", newMode: "100644",
    });
    expect(() => parseReviewManifest(ordinary)).toThrow(/index/);
  });

  test("rejects swapped, conflicting, and noncanonical rename/copy metadata", () => {
    const { repo, git } = repository("review-copy-metadata-");
    try {
      writeFileSync(join(repo, "from"), Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join(""));
      git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      copyFileSync(join(repo, "from"), join(repo, "to"));
      appendFileSync(join(repo, "to"), "edited\n");
      git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
      const item = parseReviewManifest(generateReviewManifest(repo, base, head))[0];
      expect(() => parseReviewManifest(JSON.stringify({ ...item, status: item.status.replace("C", "R") }))).toThrow();
      expect(() => parseReviewManifest(JSON.stringify({ ...item, oldPath: "to", newPath: "from", filename: "from" }))).toThrow();
      expect(() => parseReviewManifest(JSON.stringify({ ...item, patch: item.patch!.replace("copy to to", "copy to elsewhere") }))).toThrow();
      expect(() => parseReviewManifest(JSON.stringify({ ...item, patch: item.patch!.replace("copy from from\n", "copy from from\ncopy from from\n") }))).toThrow();
      expect(() => parseReviewManifest(JSON.stringify({ ...item, status: "C96" }))).toThrow();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("pins hostile path spelling and ignores head-controlled binary attributes", () => {
    const { repo, git } = repository("review-hostile-paths-");
    try {
      git(["config", "core.abbrev", "4"]);
      git(["config", "diff.noprefix", "true"]);
      git(["config", "diff.mnemonicPrefix", "true"]);
      git(["config", "diff.algorithm", "patience"]);
      git(["config", "color.ui", "always"]);
      const names = ["-dash name", "back\\slash", "line\nname", "source.ts"];
      for (const name of names) writeFileSync(join(repo, name), "old\n");
      git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      for (const name of names) appendFileSync(join(repo, name), "new\n");
      writeFileSync(join(repo, ".gitattributes"), "*.ts binary\n");
      git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
      const records = parseReviewManifest(generateReviewManifest(repo, base, head));
      expect(records.map((item) => item.filename)).toEqual([...records.map((item) => item.filename)].sort(compareReviewPaths));
      for (const name of names) {
        const item = records.find((candidate) => candidate.filename === name)!;
        expect(item.binary).toBe(false);
        expect(item.patch).toContain("+new");
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("discovers a pure copy with quoted hostile paths", () => {
    const { repo, git } = repository("review-hostile-copy-");
    try {
      const source = "source\n\\name";
      const destination = "dest\n\\name";
      writeFileSync(join(repo, source), "one\ntwo\nthree\n");
      git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      copyFileSync(join(repo, source), join(repo, destination));
      git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
      const [item] = parseReviewManifest(generateReviewManifest(repo, base, head));
      expect(item).toMatchObject({ status: "C100", oldPath: source, newPath: destination });
      expect(item.patch).toContain("copy from \"");
      expect(deriveReviewManifestCapabilities(item).rightLines.size).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("round-trips symlink-to-regular through protected, hosted, artifact, and capability boundaries", async () => {
    const { repo, git } = repository("review-type-roundtrip-");
    try {
      symlinkSync("target", join(repo, "f")); git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      unlinkSync(join(repo, "f")); writeFileSync(join(repo, "f"), "regular\n");
      git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
      const manifestText = generateReviewManifest(repo, base, head);
      const manifestPath = join(repo, "protected-manifest.jsonl");
      writeProtectedReviewManifest(manifestPath, parseReviewManifest(manifestText));
      const [item] = readProtectedReviewManifest(manifestPath);
      expect(item).toMatchObject({ status: "T", oldMode: "120000", newMode: "100644" });
      expect(deriveReviewManifestCapabilities(item).rightLines).toEqual(new Set([1]));
      const files = await listPullRequestFiles(repo, {} as never, manifestPath);
      expect(files.get("f")?.commentableLines).toEqual(new Set([1]));
      expect(() => serializeValidatedReviewArtifact({
        repository: "octo/widgets", prNumber: 1, headSha: head, baseSha: base, eventName: "pull_request",
        changedFiles: ["f"], manifestText,
        review: { commit_id: head, event: "COMMENT", body: "<!-- smithers-review -->\nReview", comments: [{ path: "f", line: 1, side: "RIGHT", body: "Finding" }] },
      })).not.toThrow();
      const previous = process.env.SMITHERS_REVIEW_IMMUTABLE_MANIFEST;
      process.env.SMITHERS_REVIEW_IMMUTABLE_MANIFEST = manifestPath;
      try {
        const diffs = await loadDiffs(repo, { ...normalizeOpenCodeReviewInput({}), repo });
        expect(diffs[0]).toMatchObject({ oldPath: "f", newPath: "f", insertions: 1, deletions: 1 });
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_REVIEW_IMMUTABLE_MANIFEST;
        else process.env.SMITHERS_REVIEW_IMMUTABLE_MANIFEST = previous;
      }
      if (process.platform !== "win32") {
        chmodSync(manifestPath, 0o644);
        expect(() => readProtectedReviewManifest(manifestPath)).toThrow(/protected/);
        chmodSync(manifestPath, 0o444);
        const alias = join(repo, "manifest-hardlink.jsonl");
        linkSync(manifestPath, alias);
        expect(() => readProtectedReviewManifest(manifestPath)).toThrow(/protected/);
        unlinkSync(alias);
      }
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("classifies text/binary transitions and invalid UTF-8 patchlessly", () => {
    for (const reverse of [false, true]) {
      const { repo, git } = repository("review-binary-transition-");
      try {
        writeFileSync(join(repo, "f"), reverse ? Buffer.from([0, 1, 2]) : "text\n");
        git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
        writeFileSync(join(repo, "f"), reverse ? "text\n" : Buffer.from([0, 1, 2]));
        git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
        const [item] = parseReviewManifest(generateReviewManifest(repo, base, head));
        expect(item).toMatchObject({ status: "M", binary: true, additions: 0, deletions: 0, oldMode: "100644", newMode: "100644" });
        expect(item.patch).toBeUndefined();
        expect(deriveReviewManifestCapabilities(item).rightLines.size).toBe(0);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    }

    for (const reverse of [false, true]) {
      const { repo, git } = repository("review-binary-type-transition-");
      try {
        if (reverse) symlinkSync("target", join(repo, "f"));
        else writeFileSync(join(repo, "f"), Buffer.from([0, 1, 2]));
        git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
        unlinkSync(join(repo, "f"));
        if (reverse) writeFileSync(join(repo, "f"), Buffer.from([0, 1, 2]));
        else symlinkSync("target", join(repo, "f"));
        git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
        const [item] = parseReviewManifest(generateReviewManifest(repo, base, head));
        expect(item).toMatchObject({ status: "T", binary: true, additions: 0, deletions: 0 });
        expect(item.patch).toBeUndefined();
        expect(item.oldMode).not.toBe(item.newMode);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    }

    const invalidBlob = repository("review-invalid-utf8-");
    try {
      writeFileSync(join(invalidBlob.repo, "f"), "valid\n"); invalidBlob.git(["add", "-A"]); invalidBlob.git(["commit", "-qm", "base"]); const base = invalidBlob.git(["rev-parse", "HEAD"]);
      writeFileSync(join(invalidBlob.repo, "f"), Buffer.from([0xc3, 0x28])); invalidBlob.git(["add", "-A"]); invalidBlob.git(["commit", "-qm", "head"]); const head = invalidBlob.git(["rev-parse", "HEAD"]);
      const [item] = parseReviewManifest(generateReviewManifest(invalidBlob.repo, base, head));
      expect(item).toMatchObject({ status: "M", binary: true, additions: 0, deletions: 0 });
      expect(item.patch).toBeUndefined();
    } finally { rmSync(invalidBlob.repo, { recursive: true, force: true }); }

    if (process.platform === "linux") {
      const invalidName = repository("review-invalid-name-");
      try {
        writeFileSync(join(invalidName.repo, "base"), "base\n"); invalidName.git(["add", "-A"]); invalidName.git(["commit", "-qm", "base"]); const base = invalidName.git(["rev-parse", "HEAD"]);
        writeFileSync(Buffer.concat([Buffer.from(`${invalidName.repo}/`), Buffer.from([0xff])]), "hostile\n");
        invalidName.git(["add", "-A"]); invalidName.git(["commit", "-qm", "head"]); const head = invalidName.git(["rev-parse", "HEAD"]);
        expect(() => generateReviewManifest(invalidName.repo, base, head)).toThrow();
      } finally { rmSync(invalidName.repo, { recursive: true, force: true }); }
    } else {
      expect(() => parseReviewManifest(Uint8Array.from([0x7b, 0xff, 0x7d]))).toThrow();
    }
  });

  test("preserves CRLF hunk payloads without treating valid Windows text as malformed", () => {
    const { repo, git } = repository("review-crlf-");
    try {
      writeFileSync(join(repo, "windows.ts"), "const value = 1;\r\nconst keep = true;\r\n");
      git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      writeFileSync(join(repo, "windows.ts"), "const value = 2;\r\nconst keep = true;\r\n");
      git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
      const [item] = parseReviewManifest(generateReviewManifest(repo, base, head));
      expect(item).toMatchObject({ status: "M", binary: false, additions: 1, deletions: 1 });
      expect(item.patch).toContain("-const value = 1;\r\n+const value = 2;\r\n");
      expect(deriveReviewManifestCapabilities(item).rightLines).toEqual(new Set([1, 2]));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("supports valid file-to-directory and directory-to-file replacements", () => {
    for (const fileFirst of [false, true]) {
      const { repo, git } = repository("review-tree-file-transition-");
      try {
        if (fileFirst) writeFileSync(join(repo, "node"), "file\n");
        else {
          mkdirSync(join(repo, "node"));
          writeFileSync(join(repo, "node", "child"), "child\n");
        }
        git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
        rmSync(join(repo, "node"), { recursive: true, force: true });
        if (fileFirst) {
          mkdirSync(join(repo, "node"));
          writeFileSync(join(repo, "node", "child"), "child\n");
        } else writeFileSync(join(repo, "node"), "file\n");
        git(["add", "-A"]); git(["commit", "-qm", "head"]); const head = git(["rev-parse", "HEAD"]);
        const records = parseReviewManifest(generateReviewManifest(repo, base, head));
        expect(records.map((item) => [item.filename, item.status])).toEqual(fileFirst
          ? [["node", "D"], ["node/child", "A"]]
          : [["node", "A"], ["node/child", "D"]]);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    }
  });

  test("fails closed for real and forged gitlinks", () => {
    const { repo, git } = repository("review-gitlink-");
    try {
      writeFileSync(join(repo, "base"), "base\n"); git(["add", "-A"]); git(["commit", "-qm", "base"]); const base = git(["rev-parse", "HEAD"]);
      git(["update-index", "--add", "--cacheinfo", `160000,${base},submodule`]);
      git(["commit", "-qm", "gitlink"]); const head = git(["rev-parse", "HEAD"]);
      expect(() => generateReviewManifest(repo, base, head)).toThrow(/unsupported|tree/i);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
