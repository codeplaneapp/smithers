import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
    __diffBundleInternals,
    applyDiffBundle,
    computeDiffBundle,
    computeDiffBundleBetweenRefs,
} from "../src/effect/diff-bundle.js";

function makeTempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
    rmSync(dir, { force: true, recursive: true });
}

function git(cwd, args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

function makeRepo() {
    const dir = makeTempDir("smithers-diff-bundle-");
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "tests@example.com"]);
    git(dir, ["config", "user.name", "Smithers Tests"]);
    return dir;
}

function commitAll(repo, message) {
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", message]);
}

describe("diff bundle", () => {
    test("computes tracked and untracked working-tree patches", async () => {
        const repo = makeRepo();
        try {
            writeFileSync(join(repo, "tracked.txt"), "one\n", "utf8");
            commitAll(repo, "initial");
            writeFileSync(join(repo, "tracked.txt"), "two\n", "utf8");
            writeFileSync(join(repo, "untracked.txt"), "new\n", "utf8");

            const bundle = await computeDiffBundle("HEAD", repo, 7);

            expect(bundle.seq).toBe(7);
            expect(bundle.baseRef).toBe("HEAD");
            expect(bundle.patches.map((patch) => [patch.path, patch.operation]).sort()).toEqual([
                ["tracked.txt", "modify"],
                ["untracked.txt", "add"],
            ]);
            expect(bundle.patches.every((patch) => patch.diff.startsWith("diff --git "))).toBe(true);
        }
        finally {
            cleanup(repo);
        }
    });

    test("computes empty, deleted, renamed and working-tree binary patches", async () => {
        const repo = makeRepo();
        try {
            writeFileSync(join(repo, "delete-me.txt"), "remove\n", "utf8");
            writeFileSync(join(repo, "tracked.bin"), Buffer.from([0, 1, 2, 3, 255]));
            writeFileSync(join(repo, "rename-me.txt"), "rename\n", "utf8");
            commitAll(repo, "initial");

            const emptyBundle = await computeDiffBundle("HEAD", repo, 3);
            expect(emptyBundle.patches).toEqual([]);

            rmSync(join(repo, "delete-me.txt"));
            git(repo, ["mv", "rename-me.txt", "renamed.txt"]);
            writeFileSync(join(repo, "tracked.bin"), Buffer.from([0, 1, 2, 4, 255]));
            writeFileSync(join(repo, "working.bin"), Buffer.from([0, 1, 2, 3, 255]));

            const bundle = await computeDiffBundle("HEAD", repo, 4);
            const byPath = new Map(bundle.patches.map((patch) => [patch.path, patch]));

            expect([...byPath.keys()].sort()).toEqual(["delete-me.txt", "renamed.txt", "tracked.bin", "working.bin"]);
            expect(byPath.get("delete-me.txt")?.operation).toBe("delete");
            expect(byPath.get("renamed.txt")?.operation).toBe("modify");
            expect(byPath.get("tracked.bin")?.operation).toBe("modify");
            expect(byPath.get("tracked.bin")?.binaryContent).toBeTruthy();
            expect(byPath.get("working.bin")?.operation).toBe("add");
            expect(byPath.get("working.bin")?.binaryContent).toBeTruthy();
        }
        finally {
            cleanup(repo);
        }
    });

    test("computes historical ref patches and embeds binary content", async () => {
        const repo = makeRepo();
        try {
            writeFileSync(join(repo, "tracked.txt"), "one\n", "utf8");
            commitAll(repo, "initial");
            writeFileSync(join(repo, "tracked.txt"), "two\n", "utf8");
            writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
            commitAll(repo, "second");
            writeFileSync(join(repo, "ignored-untracked.txt"), "working tree only\n", "utf8");

            const bundle = await computeDiffBundleBetweenRefs("HEAD~1", "HEAD", repo, 11);
            const byPath = new Map(bundle.patches.map((patch) => [patch.path, patch]));

            expect(bundle.seq).toBe(11);
            expect([...byPath.keys()].sort()).toEqual(["blob.bin", "tracked.txt"]);
            expect(byPath.get("tracked.txt")?.operation).toBe("modify");
            expect(byPath.get("blob.bin")?.operation).toBe("add");
            expect(byPath.get("blob.bin")?.binaryContent).toBeTruthy();
        }
        finally {
            cleanup(repo);
        }
    });

    test("reproduces exact binary bytes from a ref without UTF-8 corruption", async () => {
        const repo = makeRepo();
        try {
            // Bytes that are NOT valid UTF-8: lone continuation bytes (0x80-0xBF),
            // 0xFF/0xFE (never valid UTF-8), an overlong/truncated multibyte lead
            // byte (0xC0 with no continuation), plus NUL. Decoding this as UTF-8
            // (the old bug) replaces invalid sequences with U+FFFD, mangling the
            // bytes; reading raw Buffers preserves them exactly.
            const original = Buffer.from([
                0x00, 0xff, 0xfe, 0x80, 0x81, 0xbf, 0xc0, 0xc1,
                0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0x28, 0x7f,
            ]);
            writeFileSync(join(repo, "payload.bin"), original);
            commitAll(repo, "add binary payload");

            const base64 = await __diffBundleInternals.readBinaryContentAtRef(repo, "HEAD", "payload.bin");
            expect(base64).toBe(original.toString("base64"));
            // Round-trip the embedded content back to bytes and compare exactly.
            expect(Buffer.from(base64 ?? "", "base64").equals(original)).toBe(true);

            // The ref-based diff bundle must embed the same exact bytes.
            const empty = await computeDiffBundleBetweenRefs("HEAD", "HEAD", repo, 1);
            expect(empty.patches).toEqual([]);

            // Modify the binary so the bundle includes a patch for it.
            const modified = Buffer.from([
                0x00, 0xff, 0xfe, 0x80, 0x90, 0xbf, 0xc0, 0xc1,
                0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x00,
            ]);
            writeFileSync(join(repo, "payload.bin"), modified);
            commitAll(repo, "modify binary payload");

            const bundle = await computeDiffBundleBetweenRefs("HEAD~1", "HEAD", repo, 2);
            const patch = bundle.patches.find((p) => p.path === "payload.bin");
            expect(patch).toBeDefined();
            expect(patch?.operation).toBe("modify");
            expect(patch?.binaryContent).toBe(modified.toString("base64"));
            expect(Buffer.from(patch?.binaryContent ?? "", "base64").equals(modified)).toBe(true);
        }
        finally {
            cleanup(repo);
        }
    });

    test("exposes guarded internals for malformed diff and missing binary refs", async () => {
        const repo = makeRepo();
        try {
            expect(__diffBundleInternals.splitGitDiff(" \n")).toEqual([]);
            expect(__diffBundleInternals.extractPatchPath("diff --git a/old.txt b/new.txt\n")).toBe("new.txt");
            expect(() => __diffBundleInternals.extractPatchPath("diff --git without paths\n")).toThrow("Unable to determine file path");

            writeFileSync(join(repo, "tracked.txt"), "one\n", "utf8");
            commitAll(repo, "initial");
            const missing = await __diffBundleInternals.readBinaryContentAtRef(repo, "HEAD", "missing.bin");
            expect(missing).toBeUndefined();
        }
        finally {
            cleanup(repo);
        }
    });

    test("applies an empty bundle and a normal git patch", async () => {
        const target = makeTempDir("smithers-diff-apply-");
        try {
            await applyDiffBundle({ seq: 1, baseRef: "base", patches: [] }, target);
            expect(existsSync(target)).toBe(true);

            await applyDiffBundle({
                seq: 2,
                baseRef: "base",
                patches: [{
                    path: "hello.txt",
                    operation: "add",
                    diff: [
                        "diff --git a/hello.txt b/hello.txt",
                        "new file mode 100644",
                        "index 0000000..ce01362",
                        "--- /dev/null",
                        "+++ b/hello.txt",
                        "@@ -0,0 +1 @@",
                        "+hello",
                        "",
                    ].join("\n"),
                }],
            }, target);

            expect(readFileSync(join(target, "hello.txt"), "utf8")).toBe("hello\n");
        }
        finally {
            cleanup(target);
        }
    });

    test("falls back to binary writes, missing deletes and patch errors", async () => {
        const target = makeTempDir("smithers-diff-fallback-");
        try {
            await applyDiffBundle({
                seq: 1,
                baseRef: "base",
                patches: [{
                    path: "nested/blob.bin",
                    operation: "modify",
                    diff: "not a git patch\n",
                    binaryContent: Buffer.from("binary payload").toString("base64"),
                }],
            }, target);
            expect(readFileSync(join(target, "nested", "blob.bin"), "utf8")).toBe("binary payload");

            writeFileSync(join(target, "nested", "delete.bin"), "remove me", "utf8");
            await applyDiffBundle({
                seq: 2,
                baseRef: "base",
                patches: [{
                    path: "nested/delete.bin",
                    operation: "delete",
                    diff: "still not a git patch\n",
                    binaryContent: Buffer.from("ignored").toString("base64"),
                }],
            }, target);
            expect(existsSync(join(target, "nested", "delete.bin"))).toBe(false);

            await applyDiffBundle({
                seq: 3,
                baseRef: "base",
                patches: [{
                    path: "missing.txt",
                    operation: "delete",
                    diff: "still not a git patch\n",
                }],
            }, target);
            expect(existsSync(join(target, "missing.txt"))).toBe(false);

            writeFileSync(join(target, "delete-text.txt"), "remove\n", "utf8");
            await applyDiffBundle({
                seq: 4,
                baseRef: "base",
                patches: [
                    {
                        path: "added-by-fallback.txt",
                        operation: "add",
                        diff: [
                            "--- /dev/null",
                            "+++ b/added-by-fallback.txt",
                            "@@ -0,0 +1 @@",
                            "+added",
                            "",
                        ].join("\n"),
                    },
                    {
                        path: "delete-text.txt",
                        operation: "delete",
                        diff: [
                            "--- a/delete-text.txt",
                            "+++ /dev/null",
                            "@@ -1 +0,0 @@",
                            "-remove",
                            "",
                        ].join("\n"),
                    },
                    {
                        path: "force-fallback.bin",
                        operation: "modify",
                        diff: [
                            "diff --git a/force-fallback.bin b/force-fallback.bin",
                            "--- a/force-fallback.bin",
                            "+++ b/force-fallback.bin",
                            "@@ -99 +99 @@",
                            "-nope",
                            "+bad",
                            "",
                        ].join("\n"),
                        binaryContent: Buffer.from("force fallback").toString("base64"),
                    },
                ],
            }, target);
            expect(readFileSync(join(target, "added-by-fallback.txt"), "utf8")).toBe("added\n");
            expect(existsSync(join(target, "delete-text.txt"))).toBe(false);
            expect(readFileSync(join(target, "force-fallback.bin"), "utf8")).toBe("force fallback");

            await mkdir(join(target, "text"), { recursive: true });
            await writeFile(join(target, "text", "file.txt"), "original\n", "utf8");
            await expect(applyDiffBundle({
                seq: 5,
                baseRef: "base",
                patches: [{
                    path: "text/file.txt",
                    operation: "modify",
                    diff: [
                        "--- a/text/file.txt",
                        "+++ b/text/file.txt",
                        "@@ -1 +1 @@",
                        "-not-the-current-line",
                        "+updated",
                        "",
                    ].join("\n"),
                }],
            }, target)).rejects.toThrow("Failed to apply patch for text/file.txt");
        }
        finally {
            cleanup(target);
        }
    });
});
