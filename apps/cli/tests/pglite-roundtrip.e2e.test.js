import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, setDefaultTimeout, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

setDefaultTimeout(120_000);

function writePgliteWorkflow(repo) {
  repo.write(".smithers/workflows/pglite-roundtrip.tsx", [
    "/** @jsxImportSource smithers-orchestrator */",
    'import { openSmithersBackend, Workflow, Task } from "smithers-orchestrator";',
    'import { z } from "zod";',
    "",
    "const { smithers, outputs } = await openSmithersBackend({",
    "  result: z.object({",
    "    summary: z.string(),",
    "    prompt: z.string().nullable(),",
    "  }),",
    "});",
    "",
    "export default smithers((ctx) => (",
    '  <Workflow name="pglite-roundtrip">',
    '    <Task id="write-result" output={outputs.result}>',
    "      {{",
    '        summary: "fixture workflow ran",',
    "        prompt: ctx.input.prompt ?? null,",
    "      }}",
    "    </Task>",
    "  </Workflow>",
    "));",
    "",
  ].join("\n"));
}

test("pglite init/run/read round-trip uses the real PGlite store", () => {
  const repo = createTempRepo();
  writePgliteWorkflow(repo);

  const env = { SMITHERS_BACKEND: "pglite" };
  const run = runSmithers(["workflow", "run", "pglite-roundtrip", "--run-id", "pglite-roundtrip"], {
    cwd: repo.dir,
    env,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
  expect(run.json.status).toBe("finished");

  const ps = runSmithers(["ps"], { cwd: repo.dir, env, format: "json", timeoutMs: 120_000 });
  expect(ps.exitCode).toBe(0);
  expect(ps.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
  expect(JSON.stringify(ps.json)).toContain("pglite-roundtrip");

  const inspect = runSmithers(["inspect", "pglite-roundtrip"], { cwd: repo.dir, env, format: "json", timeoutMs: 120_000 });
  expect(inspect.exitCode).toBe(0);
  expect(inspect.json.run.id).toBe("pglite-roundtrip");

  const output = runSmithers(["output", "pglite-roundtrip", "write-result"], {
    cwd: repo.dir,
    env,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toContain("fixture workflow ran");
  expect(existsSync(join(repo.dir, ".smithers", "pg", "PG_VERSION"))).toBe(true);
  expect(existsSync(join(repo.dir, "smithers.db"))).toBe(false);
});
