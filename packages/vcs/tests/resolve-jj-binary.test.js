import { describe, test, expect, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { accessSync, constants as fsConstants } from "node:fs";
import { resolveBundledJjPath, resolveJjBinary } from "../src/resolveJjBinary.js";
import { ensureJjExecutable } from "../src/ensureJjExecutable.js";
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
	if (process.platform === "win32") {
		const bashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
		const scriptPath = path.join(dir, "jj.sh");
		await fs.writeFile(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${script}`, { mode: 0o755 });
		await fs.writeFile(file, `@echo off\r\n"${bashPath}" "%~dp0jj.sh" %*\r\n`, { mode: 0o755 });
	} else {
		await fs.writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${script}`, { mode: 0o755 });
	}
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

	test.skipIf(process.platform === "win32")(
		"ensureJjExecutable adds the exec bit to a non-executable bundled binary",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jj-execbit-"));
			const file = path.join(dir, "jj");
			// Simulate a binary installed WITHOUT its exec bit (the bun/pnpm
			// postinstall-skipped case that produced EACCES in the wild).
			await fs.writeFile(file, "#!/usr/bin/env bash\necho ok\n", { mode: 0o644 });
			expect(() => accessSync(file, fsConstants.X_OK)).toThrow();
			ensureJjExecutable(file);
			expect(() => accessSync(file, fsConstants.X_OK)).not.toThrow();
		},
	);

	test.skipIf(process.platform === "win32")(
		"ensureJjExecutable leaves an already-executable binary untouched",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jj-execbit-ok-"));
			const file = path.join(dir, "jj");
			await fs.writeFile(file, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
			// Must not throw even though nothing needs repair.
			ensureJjExecutable(file);
			expect(() => accessSync(file, fsConstants.X_OK)).not.toThrow();
		},
	);

	test("ensureJjExecutable is a no-op (does not throw) for a missing path", () => {
		expect(() => ensureJjExecutable(path.join(os.tmpdir(), "definitely-missing-jj-xyz"))).not.toThrow();
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
