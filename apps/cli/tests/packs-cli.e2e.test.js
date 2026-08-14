import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

// Full pack lifecycle through the real CLI binary: add → packs list →
// workflow list (pack source tier) → workflow run (real engine executing the
// pack's workflow) → remove. The fixture workflow is compute-only so the run
// needs no agent CLI (CI has none). The temp project lives inside the repo so
// the pack workflow's `smthrs` import resolves from the
// monorepo's node_modules by directory walk-up.
test("pack lifecycle end to end through the CLI: add, list, run, remove", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-packs-e2e-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  const fixture = join(dir, "fixture-src");
  mkdirSync(join(fixture, "workflows"), { recursive: true });
  writeFileSync(join(fixture, "smithers.toon"), "name: e2e-pack\nversion: 1.0.0\ncapabilities:\n  writes: none\n");
  writeFileSync(
    join(fixture, "workflows", "noop.tsx"),
    [
      "/** @jsxImportSource smthrs */",
      'import { createSmithers } from "smthrs";',
      'import { z } from "zod/v4";',
      "const { Workflow, Task, smithers, outputs } = createSmithers({",
      "    input: z.object({}),",
      "    result: z.object({ ok: z.boolean() }),",
      "});",
      "export default smithers(() => (",
      '    <Workflow name="pack-noop">',
      '        <Task id="noop" output={outputs.result}>{async () => ({ ok: true })}</Task>',
      "    </Workflow>",
      "));",
      "",
    ].join("\n"),
  );

  const add = runSmithers(["add", `file:${fixture}`, "--yes"], { cwd: dir, format: "json" });
  expect(add.exitCode).toBe(0);

  const list = runSmithers(["packs", "list"], { cwd: dir, format: "json" });
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain("e2e-pack");

  const workflows = runSmithers(["workflow", "list"], { cwd: dir, format: "json" });
  expect(workflows.exitCode).toBe(0);
  expect(workflows.stdout).toContain("pack:e2e-pack");

  const run = runSmithers(["workflow", "run", "e2e-pack:noop", "--input", "{}"], { cwd: dir, format: "json" });
  expect(run.exitCode).toBe(0);

  const remove = runSmithers(["remove", "e2e-pack"], { cwd: dir, format: "json" });
  expect(remove.exitCode).toBe(0);
  const after = runSmithers(["packs", "list"], { cwd: dir, format: "json" });
  expect(after.stdout).not.toContain("e2e-pack");
}, 180_000);
