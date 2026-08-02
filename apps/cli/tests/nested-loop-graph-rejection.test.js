import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
// examples/ resolves `smthrs` via the repo root's hoisted
// workspace node_modules (see examples-graph-smoke.test.js), unlike an
// arbitrary tmp directory outside the monorepo.
const FIXTURE_PATH = resolve(REPO_ROOT, "examples", "_nested-loop-rejection-fixture.jsx");

// A <Loop> as the literal immediate JSX child of another <Loop> has no clear
// "whose iteration is this" semantics and the engine cannot execute it —
// `smithers graph` must reject it statically instead of failing at runtime.
// This is the JSX-authoring analogue of the Effect builder's unconditional
// `annotateLoops` NESTED_LOOP rejection (packages/engine/src/effect/builder.js).
// (A <Loop> reached through a <Sequence>/<Parallel>/<Worktree> wrapper is a
// different, genuinely-executable shape — see the issue #117 regression test
// at packages/engine/tests/nested-loop-runtime.test.jsx — and must NOT be
// rejected.)
const NESTED_LOOP_FIXTURE = `
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Loop, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ ok: z.boolean() }),
});

export default smithers((ctx) => {
  return (
    <Workflow name="nested-loop-fixture">
      <Loop id="outer" until={false} maxIterations={2}>
        <Loop id="inner" until={false} maxIterations={2}>
          <Task id="t1" output={outputs.result}>
            {{ ok: true }}
          </Task>
        </Loop>
      </Loop>
    </Workflow>
  );
});
`;

test("smithers graph fails fast (statically) on a literal immediate nested <Loop>", () => {
  writeFileSync(FIXTURE_PATH, NESTED_LOOP_FIXTURE, "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      ["run", CLI_ENTRY, "graph", "examples/_nested-loop-rejection-fixture.jsx"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("Nested <Loop>/<Ralph>");
    // The error must name both loop ids and suggest the queue-based fix.
    expect(combined).toContain("outer");
    expect(combined).toContain("inner");
    expect(combined).toContain("MergeQueue");
  } finally {
    rmSync(FIXTURE_PATH, { force: true });
  }
}, 60_000);
