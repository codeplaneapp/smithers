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

describe("createAwsSandboxS3Transport public type", () => {
  test("accepts workdir for direct TypeScript callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-aws-s3-transport-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "aws-s3-transport.ts"),
      `
				import { createAwsSandboxS3Transport } from "@smthrs/aws";

				createAwsSandboxS3Transport({
					s3: {
						putObject: async () => ({}),
						getObject: async () => ({}),
						deleteObjects: async () => ({}),
					},
					bucket: "bucket",
					prefix: "prefix",
					workdir: "/workspace",
				});
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
            "@smthrs/aws": [resolve(REPO_ROOT, "packages/aws/src/index.d.ts")],
          },
          skipLibCheck: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
        },
        include: ["aws-s3-transport.ts"],
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
