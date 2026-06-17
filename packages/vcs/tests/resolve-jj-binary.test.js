import { describe, test, expect, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { resolveBundledJjPath, resolveJjBinary } from "../src/resolveJjBinary.js";
import { runJj } from "../src/jj.js";

const ENV_KEY = "SMITHERS_JJ_PATH";
const prevOverride = process.env[ENV_KEY];

afterEach(() => {
	if (prevOverride === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = prevOverride;
});

/**
 * Write a throwaway executable that behaves like `jj` for one assertion.
 * @param {string} script bash body (POSIX) / batch body (win32)
 * @returns {Promise<string>} absolute path to the executable
 */
async function writeFakeBinary(script) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-jj-"));
	const file = path.join(dir, process.platform === "win32" ? "jj.cmd" : "jj");
	const body =
		process.platform === "win32"
			? `@echo off\r\n${script.replaceAll("\n", "\r\n")}`
			: `#!/usr/bin/env bash\nset -euo pipefail\n${script}`;
	await fs.writeFile(file, body, { mode: 0o755 });
	return file;
}

describe("resolveJjBinary", () => {
	test("honors SMITHERS_JJ_PATH when it points at a real file", async () => {
		const fake = await writeFakeBinary(`echo ok`);
		process.env[ENV_KEY] = fake;
		expect(resolveJjBinary()).toEqual({ path: fake, source: "env" });
	});

	test("ignores SMITHERS_JJ_PATH when the file does not exist", () => {
		process.env[ENV_KEY] = path.join(os.tmpdir(), "definitely-not-here-jj");
		const resolved = resolveJjBinary();
		expect(resolved.source).not.toBe("env");
	});

	test("without an override, resolves either a bundled binary or PATH (never env)", () => {
		delete process.env[ENV_KEY];
		const resolved = resolveJjBinary();
		// Robust whether or not `pnpm fetch:jj` has populated a bundled binary:
		// no override means the bundled branch or the PATH fallback, and the
		// PATH fallback is exactly the bare "jj".
		expect(resolved.source).not.toBe("env");
		if (resolved.source === "path") expect(resolved.path).toBe("jj");
		else expect(resolved.source).toBe("bundled");
	});

	test("resolves the bundled binary when the platform package binary exists", async () => {
		const manifest = path.join(os.tmpdir(), "jj-package", "package.json");
		const resolved = resolveBundledJjPath({
			platform: "darwin",
			arch: "x64",
			resolvePackage: () => manifest,
			fileExists: (file) => String(file).endsWith(path.join("bin", "jj")),
		});
		expect(resolved).toBe(path.join(manifest, "..", "bin", "jj"));
	});

	test("returns null when bundled package resolution throws", () => {
		const resolved = resolveBundledJjPath({
			platform: "darwin",
			arch: "x64",
			resolvePackage: () => {
				throw new Error("missing optional package");
			},
		});
		expect(resolved).toBeNull();
	});

	test("returns null on unsupported platforms", () => {
		expect(resolveBundledJjPath({ platform: "freebsd", arch: "x64" })).toBeNull();
	});

	test("runJj spawns the resolved binary (override branch)", async () => {
		const fake = await writeFakeBinary(`echo resolved-binary; exit 0`);
		process.env[ENV_KEY] = fake;
		const res = await Effect.runPromise(
			runJj(["whatever"]).pipe(Effect.provide(BunContext.layer)),
		);
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe("resolved-binary");
	});
});
