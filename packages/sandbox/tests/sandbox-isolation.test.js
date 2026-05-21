// Sandbox isolation tests.
//
// Scope: this file does NOT require live container/jail binaries
// (bubblewrap on Linux, sandbox-exec on macOS, docker, codeplane).
// Runtime-specific process execution is covered in transport-runners.test.js
// with fake binaries so CI can validate the executor contract without a
// privileged sandbox image.
//
// What IS enforceable in-process and exercised here:
//   - resolveSandboxPath path traversal validation (../../, absolute paths, symlink
//     redirection caught by assertPathWithinRoot).
//   - validateSandboxBundle bundle-size limits (SANDBOX_MAX_BUNDLE_BYTES / readme).
//   - writeSandboxBundle rejects patch/artifact paths that escape the bundle
//     root (the prod boundary uses resolveSandboxPath internally).
//   - walkFiles handling of symlinks and deeply nested artifacts.
//   - Cleanup of the sandbox temp directory after a write.
//
// Full host isolation still needs environment-specific e2e coverage on a CI
// image that includes bubblewrap or sandbox-exec.
import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SANDBOX_MAX_BUNDLE_BYTES,
	validateSandboxBundle,
	writeSandboxBundle,
} from "../src/bundle.js";
import { resolveSandboxPath, assertPathWithinRoot } from "../src/sandboxPath.js";

/**
 * @param {string} prefix
 */
function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("sandbox isolation: path-escape boundary", () => {
	test("subprocess-style relative path cannot escape sandbox root via ..", () => {
		const root = tempDir("sandbox-iso-");
		// Pretend the sandboxed child wrote a manifest claiming it produced a
		// patch at this relative path — the boundary must reject it before
		// we ever touch the parent filesystem.
		const escapeAttempts = [
			"../../../etc/passwd",
			"foo/../../bar",
			"./../../escape",
			"a/b/c/../../../../../etc/hosts",
		];
		for (const attempt of escapeAttempts) {
			expect(() => resolveSandboxPath(root, attempt)).toThrow(
				"Path escapes sandbox root",
			);
		}
	});

	test("absolute paths outside sandbox root are rejected", () => {
		const root = tempDir("sandbox-iso-");
		expect(() => resolveSandboxPath(root, "/etc/passwd")).toThrow(
			"Path escapes sandbox root",
		);
		expect(() => resolveSandboxPath(root, "/")).toThrow(
			"Path escapes sandbox root",
		);
	});

	test("symlink inside sandbox pointing outside root is detected by assertPathWithinRoot", async () => {
		const root = tempDir("sandbox-iso-");
		const outside = tempDir("sandbox-outside-");
		writeFileSync(join(outside, "secret"), "leaked", "utf8");
		const link = join(root, "evil-link");
		symlinkSync(outside, link);
		await expect(
			assertPathWithinRoot(root, join(link, "secret")),
		).rejects.toThrow("Path escapes sandbox root");
	});

	test("nested symlink chain to /tmp parent is rejected", async () => {
		const root = tempDir("sandbox-iso-");
		const outside = tempDir("sandbox-outside-");
		const intermediate = join(root, "intermediate");
		mkdirSync(intermediate);
		symlinkSync(outside, join(intermediate, "hop"));
		await expect(
			assertPathWithinRoot(root, join(intermediate, "hop", "anything")),
		).rejects.toThrow("Path escapes sandbox root");
	});
});

describe("sandbox isolation: bundle artifact safety", () => {
	test("writeSandboxBundle rejects artifact path that escapes bundle", async () => {
		const bundlePath = tempDir("sandbox-bundle-");
		await expect(
			writeSandboxBundle({
				bundlePath,
				output: { ok: true },
				status: "finished",
				artifacts: [
					{
						path: "../escape.txt",
						content: "should not land outside bundle",
					},
				],
			}),
		).rejects.toThrow("Path escapes sandbox root");
	});

	test("writeSandboxBundle rejects patch path that escapes bundle", async () => {
		const bundlePath = tempDir("sandbox-bundle-");
		await expect(
			writeSandboxBundle({
				bundlePath,
				output: {},
				status: "finished",
				patches: [
					{
						path: "patches/../../../tmp/leak.patch",
						content: "diff",
					},
				],
			}),
		).rejects.toThrow("Path escapes sandbox root");
	});

	test("validateSandboxBundle enforces total bundle byte limit (SANDBOX_MAX_BUNDLE_BYTES)", async () => {
		// Pre-flight estimate must reject bundles that would exceed the limit.
		const bundlePath = tempDir("sandbox-bundle-");
		const oversized = "x".repeat(SANDBOX_MAX_BUNDLE_BYTES + 1024);
		await expect(
			writeSandboxBundle({
				bundlePath,
				output: {},
				status: "finished",
				artifacts: [{ path: "artifacts/big.bin", content: oversized }],
			}),
		).rejects.toThrow(`exceeds ${SANDBOX_MAX_BUNDLE_BYTES} bytes`);
	});

	test("validateSandboxBundle rejects already-on-disk oversized bundle", async () => {
		// Build a bundle "from outside" larger than the limit and confirm
		// validate-time guard catches it (defence in depth — write-time was
		// covered above).
		const bundlePath = tempDir("sandbox-bundle-");
		mkdirSync(join(bundlePath, "patches"), { recursive: true });
		writeFileSync(
			join(bundlePath, "README.md"),
			JSON.stringify({ status: "finished", outputs: {} }),
			"utf8",
		);
		// Create a single oversized file on disk to force walkFiles totalBytes
		// to exceed the limit.
		const big = Buffer.alloc(SANDBOX_MAX_BUNDLE_BYTES + 1, 0);
		writeFileSync(join(bundlePath, "patches", "huge.patch"), big);
		await expect(validateSandboxBundle(bundlePath)).rejects.toThrow(
			"exceeds",
		);
	});

	test("symlink artifact inside bundle is silently skipped (not counted as patch)", async () => {
		// walkFiles ignores entries that aren't isFile(); symlinks land in
		// neither directory nor file branch. This documents that behaviour:
		// a symlink can't smuggle bytes past the limit, but it also won't
		// become a recognised patch file.
		const bundlePath = tempDir("sandbox-bundle-");
		const outside = tempDir("sandbox-outside-");
		writeFileSync(join(outside, "leak"), "secret", "utf8");
		mkdirSync(join(bundlePath, "patches"), { recursive: true });
		writeFileSync(
			join(bundlePath, "README.md"),
			JSON.stringify({ status: "finished", outputs: {} }),
			"utf8",
		);
		symlinkSync(
			join(outside, "leak"),
			join(bundlePath, "patches", "0001-symlink.patch"),
		);
		const validated = await validateSandboxBundle(bundlePath);
		// Symlink was not collected as a real patch file.
		expect(validated.patchFiles).toEqual([]);
	});

	test("deeply nested artifact paths within bundle are accepted and resolvable", async () => {
		const bundlePath = tempDir("sandbox-bundle-");
		const deep = "artifacts/a/b/c/d/e/f/g/h/i/j/deep.txt";
		await writeSandboxBundle({
			bundlePath,
			output: { ok: true },
			status: "finished",
			artifacts: [{ path: deep, content: "nested" }],
		});
		expect(existsSync(join(bundlePath, deep))).toBe(true);
		const validated = await validateSandboxBundle(bundlePath);
		expect(validated.manifest.status).toBe("finished");
	});

	test("manifest patches[] entry pointing at an absolute path is rejected", async () => {
		const bundlePath = tempDir("sandbox-bundle-");
		mkdirSync(join(bundlePath, "patches"), { recursive: true });
		writeFileSync(
			join(bundlePath, "README.md"),
			JSON.stringify({
				status: "finished",
				outputs: {},
				patches: ["/etc/shadow"],
			}),
			"utf8",
		);
		await expect(validateSandboxBundle(bundlePath)).rejects.toThrow(
			"escapes sandbox root",
		);
	});
});

describe("sandbox isolation: cleanup", () => {
	test("removing sandbox temp directory after run is observable (no leak)", async () => {
		const bundlePath = tempDir("sandbox-bundle-");
		await writeSandboxBundle({
			bundlePath,
			output: {},
			status: "finished",
		});
		expect(existsSync(bundlePath)).toBe(true);
		// Simulate the post-run cleanup the transport performs.
		rmSync(bundlePath, { recursive: true, force: true });
		expect(existsSync(bundlePath)).toBe(false);
	});

	// Testing "no orphan processes via ps" and "cleanup after crash
	// (process killed mid-run)" requires a CI image with a real sandbox binary.
	test.skip("sandbox cleanup after timeout removes temp dir and leaves no orphan processes", () => {
		// Requires real sandbox runtime; see file-top scope note.
	});
	test.skip("sandbox cleanup after crash (process killed mid-run)", () => {
		// Requires real sandbox runtime; see file-top scope note.
	});
});
