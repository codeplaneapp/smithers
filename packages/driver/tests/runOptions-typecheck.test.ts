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
        import type { OutputRowsReader, RunOptions, RunStartedBy, SmithersErrorReport } from "@smthrs/driver";

        type Outputs = { rows: { value: number } };
        declare const rowsReader: OutputRowsReader<Outputs>;
        const value: number = (rowsReader("rows")[0].payload as { value: number }).value;
        void value;

        const reports: SmithersErrorReport[] = [];
        const startedBy: RunStartedBy = { harness: "codex", sessionId: "session" };

        const options: RunOptions = {
          input: {},
          effectPlatformRuntime: "node",
          effectPlatformLayer: {} as RunOptions["effectPlatformLayer"],
          startedBy,
          initialOutputs: {
            rows: [{ value: 1 }],
          },
          initialIteration: 3,
          initialIterations: {
            task: 2,
          },
          onError: (report) => {
            reports.push(report);
            report.error.code;
            report.rawError;
            if (report.phase === "node") {
              const nodeId: string = report.nodeId;
              const attempt: number = report.attempt;
              void nodeId;
              void attempt;
            } else {
              const nodeId: undefined = report.nodeId;
              void nodeId;
            }
          },
        };

        void options;
        void reports;
      `,
    );

    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          ignoreDeprecations: "6.0",
          strict: true,
          noEmit: true,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          paths: {
            "@smthrs/driver": [resolve(REPO_ROOT, "packages/driver/src/index.d.ts")],
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
    // Spawns a full `tsc` subprocess, which can exceed the default 5s under a
    // CPU-saturated CI test run; give it a generous ceiling so it doesn't flake.
  }, 60_000);
});
