import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * `${process.platform}-${process.arch}` → the npm package that vendors a `jj`
 * binary for that target. Each package carries `os`/`cpu` fields so a package
 * manager only installs the one matching the host, and exposes the binary at
 * `bin/jj` (`bin/jj.exe` on Windows).
 *
 * Kept in sync with the platform packages under `packages/jj-binaries/` and the
 * `optionalDependencies` of `@smithers-orchestrator/vcs`.
 *
 * @type {Record<string, string>}
 */
const BUNDLED_PACKAGES = {
	"darwin-arm64": "@smithers-orchestrator/jj-darwin-arm64",
	"darwin-x64": "@smithers-orchestrator/jj-darwin-x64",
	"linux-arm64": "@smithers-orchestrator/jj-linux-arm64",
	"linux-x64": "@smithers-orchestrator/jj-linux-x64",
	"win32-x64": "@smithers-orchestrator/jj-win32-x64",
};

/**
 * Locate the bundled `jj` binary for the current host, or null when no platform
 * package is installed (unsupported target, `--no-optional` install, or not yet
 * published). Resolution goes through the package's `package.json` so it works
 * regardless of hoisting layout.
 *
 * @returns {string | null}
 */
export function resolveBundledJjPath({
	platform = process.platform,
	arch = process.arch,
	resolvePackage = require.resolve,
	fileExists = existsSync,
} = {}) {
	const pkg = BUNDLED_PACKAGES[`${platform}-${arch}`];
	if (!pkg) return null;
	const binary = platform === "win32" ? "jj.exe" : "jj";
	try {
		const manifest = resolvePackage(`${pkg}/package.json`);
		const candidate = join(manifest, "..", "bin", binary);
		return fileExists(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

/**
 * Resolve the `jj` executable Smithers should spawn.
 *
 * Order of preference:
 *   1. `SMITHERS_JJ_PATH` — an explicit override pointing at a real file.
 *   2. A binary bundled via `@smithers-orchestrator/jj-<platform>`.
 *   3. The bare `"jj"`, left for the OS to resolve against `PATH`.
 *
 * Always returns a spawnable command. When jj is genuinely absent the bare
 * `"jj"` simply fails to spawn, which `runJj` already normalizes to exit code
 * 127, so callers keep their soft-failure behavior.
 *
 * @returns {import("./ResolvedBinary.js").ResolvedBinary}
 */
export function resolveJjBinary() {
	const override = process.env.SMITHERS_JJ_PATH;
	if (override && existsSync(override)) return { path: override, source: "env" };
	const bundled = resolveBundledJjPath();
	if (bundled) return { path: bundled, source: "bundled" };
	return { path: "jj", source: "path" };
}
