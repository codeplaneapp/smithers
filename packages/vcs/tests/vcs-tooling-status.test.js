import { describe, test, expect, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { resolveGitBinary } from "../src/resolveGitBinary.js";
import { runsVersion, vcsToolingStatus } from "../src/vcsToolingStatus.js";

const JJ_KEY = "SMITHERS_JJ_PATH";
const GIT_KEY = "SMITHERS_GIT_PATH";
const saved = {
	[JJ_KEY]: process.env[JJ_KEY],
	[GIT_KEY]: process.env[GIT_KEY],
	PATH: process.env.PATH,
};

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/**
 * Write a throwaway executable for one assertion.
 * @param {string} name file name (e.g. "jj" or "git")
 * @param {number} [exitCode] process exit code (0 = a working binary)
 * @returns {Promise<string>}
 */
async function writeBinary(name, exitCode = 0) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-tooling-"));
	const file = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
	const body =
		process.platform === "win32"
			? `@echo off\r\necho ${name} 1.0\r\nexit /b ${exitCode}\r\n`
			: `#!/usr/bin/env bash\necho "${name} 1.0"\nexit ${exitCode}\n`;
	await fs.writeFile(file, body, { mode: 0o755 });
	return file;
}

describe("resolveGitBinary", () => {
	test("honors SMITHERS_GIT_PATH when it points at a real file", async () => {
		const fake = await writeBinary("git");
		process.env[GIT_KEY] = fake;
		expect(resolveGitBinary()).toEqual({ path: fake, source: "env" });
	});

	test("falls back to bare \"git\" on PATH otherwise", () => {
		delete process.env[GIT_KEY];
		expect(resolveGitBinary()).toEqual({ path: "git", source: "path" });
	});

	test("ignores SMITHERS_GIT_PATH when the file does not exist", () => {
		process.env[GIT_KEY] = path.join(os.tmpdir(), "definitely-not-here-git");
		expect(resolveGitBinary()).toEqual({ path: "git", source: "path" });
	});
});

describe("vcsToolingStatus", () => {
	test("reports git unusable when the resolved git fails --version", async () => {
		const broken = await writeBinary("git", 1);
		process.env[GIT_KEY] = broken;
		expect(vcsToolingStatus().git).toBeNull();
	});

	test("reports jj usable via SMITHERS_JJ_PATH override", async () => {
		const fake = await writeBinary("jj");
		process.env[JJ_KEY] = fake;
		const status = vcsToolingStatus();
		expect(status.jj).toEqual({ path: fake, source: "env" });
		expect(status.ok).toBe(true);
	});

	test("reports git usable via SMITHERS_GIT_PATH override", async () => {
		const fake = await writeBinary("git");
		process.env[GIT_KEY] = fake;
		const status = vcsToolingStatus();
		expect(status.git).toEqual({ path: fake, source: "env" });
		expect(status.ok).toBe(true);
	});

	test("reports ok false when neither resolved binary runs --version", async () => {
		const brokenJj = await writeBinary("jj", 1);
		const brokenGit = await writeBinary("git", 1);
		process.env[JJ_KEY] = brokenJj;
		process.env[GIT_KEY] = brokenGit;
		expect(vcsToolingStatus()).toEqual({ jj: null, git: null, ok: false });
	});

	test("reports jj null while git remains usable", async () => {
		const brokenJj = await writeBinary("jj", 1);
		const git = await writeBinary("git");
		process.env[JJ_KEY] = brokenJj;
		process.env[GIT_KEY] = git;
		expect(vcsToolingStatus()).toEqual({
			jj: null,
			git: { path: git, source: "env" },
			ok: true,
		});
	});

	test("treats spawnSync exceptions as unusable binaries", async () => {
		expect(runsVersion({ path: "\0", source: "path" })).toBe(false);
	});
});
