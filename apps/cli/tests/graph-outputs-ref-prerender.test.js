import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");

function symlinkDir(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
}

// The CLI's pre-render contexts (`graph`, resume input recovery) construct a
// SmithersCtx directly from the loaded DB snapshot. They must pass the
// workflow's zodToKeyName map through, or a workflow that calls the callable
// form `ctx.outputs(outputs.someRef)` during render dies with
// OUTPUT_TABLE_UNRESOLVABLE before the engine ever starts (the engine-side
// WorkflowDriver ctx always passed it).
const WORKFLOW = `
import { createSmithers, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  probe: z.object({ note: z.string() }),
});

export default smithers((ctx) => {
  const seen = ctx.outputs(outputs.probe).length;
  return (
    <Workflow name="graph-outputs-ref">
      <Task id="t1" output={outputs.probe}>{"rows so far: " + seen}</Task>
    </Workflow>
  );
});
`;

test("graph renders a workflow whose render calls ctx.outputs(outputs.ref)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-graph-outputs-ref-"));
  try {
    const modulesDir = join(dir, "node_modules");
    symlinkDir(resolve(REPO_ROOT, "packages/smithers"), join(modulesDir, "smthrs"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/@smthrs"), join(modulesDir, "@smthrs"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/react"), join(modulesDir, "react"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/zod"), join(modulesDir, "zod"));
    writeFileSync(join(dir, "workflow.jsx"), WORKFLOW, "utf8");

    const child = Bun.spawn(
      [process.execPath, "run", CLI_ENTRY, "graph", join(dir, "workflow.jsx"), "--format", "json"],
      { cwd: dir, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).not.toContain("OUTPUT_TABLE_UNRESOLVABLE");
    expect(stdout).not.toContain("OUTPUT_TABLE_UNRESOLVABLE");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("graph-outputs-ref");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
