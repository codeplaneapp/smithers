import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLATFORM_BINARIES = {
	"jj-darwin-arm64": "bin/jj",
	"jj-darwin-x64": "bin/jj",
	"jj-linux-arm64": "bin/jj",
	"jj-linux-x64": "bin/jj",
	"jj-win32-x64": "bin/jj.exe",
};
const hostPackage = `jj-${process.platform}-${process.arch}`;

/** @param {Buffer} field */
function tarString(field) {
	const nul = field.indexOf(0);
	return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

/** @param {Buffer} field */
function tarOctal(field) {
	const text = tarString(field).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

/**
 * Read one regular tar entry's mode without depending on a platform `tar` CLI.
 * @param {Buffer} compressed
 * @param {string} wanted
 */
function tarEntryMode(compressed, wanted) {
	const archive = gunzipSync(compressed);
	for (let offset = 0; offset + 512 <= archive.length;) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = tarString(header.subarray(0, 100));
		const prefix = tarString(header.subarray(345, 500));
		const fullName = prefix ? `${prefix}/${name}` : name;
		const size = tarOctal(header.subarray(124, 136));
		if (fullName === wanted) return tarOctal(header.subarray(100, 108));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error(`tar entry not found: ${wanted}`);
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

describe("bundled jj package executable mode", () => {
	test("every platform manifest declares the vendored file as the jj npm binary", async () => {
		for (const [packageDir, binary] of Object.entries(PLATFORM_BINARIES)) {
			const manifest = JSON.parse(await fs.readFile(
				path.join(root, "packages", packageDir, "package.json"),
				"utf8",
			));
			expect(manifest.bin, packageDir).toEqual({ jj: binary });
			if (binary === "bin/jj") {
				expect(manifest.scripts.prepack, packageDir).toContain("chmodSync(p,0o755)");
			}
		}
	});

	test.skipIf(process.platform === "win32" || !PLATFORM_BINARIES[hostPackage])(
		"npm packs mode 0755 and pnpm keeps it when lifecycle scripts are ignored",
		async () => {
			const temp = await fs.mkdtemp(path.join(os.tmpdir(), "smithers-jj-pack-"));
			try {
				const sourceDir = path.join(temp, "source");
				const packDir = path.join(temp, "packed");
				const consumerDir = path.join(temp, "consumer");
				const binaryRelative = PLATFORM_BINARIES[hostPackage];
				const binaryPath = path.join(sourceDir, binaryRelative);
				const sourceManifest = JSON.parse(await fs.readFile(
					path.join(root, "packages", hostPackage, "package.json"),
					"utf8",
				));
				// Failing here proves the install below really skipped lifecycle scripts;
				// the executable result must come from package metadata, not chmod.
				sourceManifest.scripts = {
					...sourceManifest.scripts,
					postinstall: 'node -e "process.exit(97)"',
				};

				await fs.mkdir(path.dirname(binaryPath), { recursive: true });
				await fs.mkdir(packDir, { recursive: true });
				await fs.mkdir(consumerDir, { recursive: true });
				await fs.writeFile(path.join(sourceDir, "package.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
				await fs.writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
				expect((await fs.stat(binaryPath)).mode & 0o111).toBe(0);

				const packed = JSON.parse(run("npm", [
					"pack",
					sourceDir,
					"--json",
					"--pack-destination",
					packDir,
				], root));
				const tarball = path.join(packDir, packed[0].filename);
				expect(tarEntryMode(await fs.readFile(tarball), "package/bin/jj") & 0o777).toBe(0o755);

				await fs.writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify({
					private: true,
					dependencies: { [sourceManifest.name]: `file:${tarball}` },
				}, null, 2)}\n`);
				run("pnpm", [
					"install",
					"--ignore-scripts",
					"--no-frozen-lockfile",
					"--lockfile=false",
				], consumerDir);

				const installed = path.join(
					consumerDir,
					"node_modules",
					...sourceManifest.name.split("/"),
					binaryRelative,
				);
				expect((await fs.stat(installed)).mode & 0o777).toBe(0o755);
			} finally {
				await fs.rm(temp, { recursive: true, force: true });
			}
		},
	);
});
