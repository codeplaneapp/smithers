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

describe("RunOptions public type", () => {
  test("accepts initial output and iteration options read by WorkflowDriver.run", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-driver-run-options-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "run-options.ts"),
      `
        import type { RunOptions } from "@smithers-orchestrator/driver";

        const options: RunOptions = {
          input: {},
          initialOutputs: {
            rows: [{ value: 1 }],
          },
          initialIteration: 3,
          initialIterations: {
            task: 2,
          },
        };

        void options;
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
          baseUrl: ".",
          paths: {
            "@smithers-orchestrator/driver": [
              resolve(REPO_ROOT, "packages/driver/src/index.d.ts"),
            ],
          },
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
        },
        include: ["run-options.ts"],
      }),
    );

    const result = spawnSync(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  });
});
