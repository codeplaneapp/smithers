import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TSC = resolve(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("CloudflareSandboxProviderOptions public type", () => {
	test("accepts string and numeric sleepAfter values", () => {
		const dir = mkdtempSync(join(tmpdir(), "smithers-cloudflare-options-"));
		tempDirs.push(dir);

		writeFileSync(
			join(dir, "cloudflare-options.ts"),
			`
				import {
					createCloudflareSandboxProvider,
					type CloudflareSandboxProviderOptions,
				} from "@smithers-orchestrator/cloudflare";

				const stringOptions: CloudflareSandboxProviderOptions = { sleepAfter: "10m" };
				const numericOptions: CloudflareSandboxProviderOptions = { sleepAfter: 600 };
				createCloudflareSandboxProvider(stringOptions);
				createCloudflareSandboxProvider(numericOptions);
			`,
		);
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: "ESNext",
					module: "ESNext",
					moduleResolution: "bundler",
					paths: {
						"@smithers-orchestrator/cloudflare": [
							resolve(REPO_ROOT, "packages/cloudflare/src/index.d.ts"),
						],
					},
					skipLibCheck: true,
					lib: ["ESNext", "DOM", "DOM.Iterable"],
				},
				include: ["cloudflare-options.ts"],
			}),
		);

		const result = spawnSync(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(`${result.stdout}${result.stderr}`).toBe("");
		expect(result.status).toBe(0);
	}, 60_000);
});
