import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedClone } from "@smthrs/vcs";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const ENV_WORKFLOW = `
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({ result: z.object({ ok: z.boolean() }) });
export default smithers(() => {
  if (process.env.GIT_EDITOR !== undefined) throw new Error("GIT_EDITOR leaked into engine");
  if (process.env.SMITHERS_HOME !== undefined) throw new Error("SMITHERS_HOME leaked into engine");
  if (process.env.EXPLICIT_WORKFLOW_ENV !== "yes") throw new Error("explicit environment missing");
  return <Workflow name="environment-contract"><Task id="result" output={outputs.result}>{{ ok: true }}</Task></Workflow>;
}, { environment: { inherit: false, allow: ["PATH", "HOME"], set: { EXPLICIT_WORKFLOW_ENV: "yes" } } });
`;

const FAILURE_WORKFLOW = `
/** @jsxImportSource smthrs */
import { createSmithers, SmithersErrorInstance, TryCatchFinally, Sequence } from "smthrs";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({
  diagnostic: z.object({ summary: z.string(), blockers: z.array(z.string()) }),
  gate: z.object({ ok: z.boolean() }),
});
export default smithers(() => <Workflow name="leaf-errors"><TryCatchFinally id="manifest-cleanup-lifecycle"
  catchErrors={["TOOL_TIMEOUT"]}
  try={<Sequence>
    <Task id="probe" output={outputs.diagnostic}>{{ summary: "git ref inventory failed", blockers: ["spawnSync git ENOBUFS"] }}</Task>
    <Task id="gate" output={outputs.gate}>{() => { throw new SmithersErrorInstance("INVALID_INPUT", "fail closed"); }}</Task>
  </Sequence>}
/></Workflow>);
`;

test("workflow environment contracts scrub ambient GIT_* and SMITHERS_HOME in a real CLI process", () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  repo.write("workflow.tsx", ENV_WORKFLOW);
  const result = runSmithers(["graph", "workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
    env: { ...process.env, GIT_EDITOR: "true", SMITHERS_HOME: "/wrong/accounts" },
    timeoutMs: 120_000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
});

test("path-like workflow arguments fail before run state when launched from a clone subdirectory", async () => {
  const source = createTempRepo();
  pinSqliteBackend(source.dir);
  source.write(".smithers/workflows/actual.tsx", ENV_WORKFLOW);
  execFileSync("git", ["init"], { cwd: source.dir });
  execFileSync("git", ["config", "user.email", "test@smithers.local"], { cwd: source.dir });
  execFileSync("git", ["config", "user.name", "Smithers Test"], { cwd: source.dir });
  execFileSync("git", ["add", "."], { cwd: source.dir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: source.dir });
  const capsule = await createIsolatedClone({ repo: source.dir, at: "HEAD" });
  try {
    const cwd = join(capsule.path, ".smithers");
    for (const command of ["graph", "up"]) {
      const args = [command, ".smithers/workflows/missing.tsx", ...(command === "up" ? ["--no-report"] : [])];
      const result = runSmithers(args, {
        cwd,
        format: "json",
        timeoutMs: 120_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.json?.code).toBe("WORKFLOW_FILE_NOT_FOUND");
      expect(result.json?.message).toContain(`resolved: ${join(realpathSync(cwd), ".smithers/workflows/missing.tsx")}`);
    }
    expect(existsSync(join(capsule.path, "smithers.db"))).toBe(false);
    expect(existsSync(join(capsule.path, ".smithers", "logs"))).toBe(false);
  } finally {
    await capsule.cleanup();
  }
}, 120_000);

test("run-level scheduler errors include summary and blockers from the leaf output row", () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  repo.write("workflow.tsx", FAILURE_WORKFLOW);
  const result = runSmithers(["up", "workflow.tsx", "--run-id", "leaf-error", "--no-report"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("TryCatchFinally manifest-cleanup-lifecycle failed");
  expect(`${result.stdout}\n${result.stderr}`).toContain("git ref inventory failed");
  expect(`${result.stdout}\n${result.stderr}`).toContain("spawnSync git ENOBUFS");
});
