import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import pinnedWorkflow, { runGateUnsafe as runPinnedGate } from "../workflows/sol-issue-train-pinned";
import workflow, { runGateUnsafe as runGate } from "../workflows/sol-issue-train";

const FULL_GATE_COMMAND =
  "pnpm typecheck && pnpm lint && pnpm check:docs && pnpm check:llms && pnpm check:deps && pnpm check:dts && pnpm test";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sol-issue-train-gate-"));
  git(root, ["init", "-q"]);
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.name=Smithers Test", "-c", "user.email=test@smithers.invalid", "commit", "-qm", "fixture"]);
  return root;
}

// createSmithers() attaches the workflow input schema to the returned workflow
// object, but the public WorkflowDefinition type does not declare it yet.
type WorkflowWithInputSchema = { inputSchema: { parse(input: unknown): { gateCommand: string } } };
const inputSchemaOf = (candidate: unknown) => (candidate as WorkflowWithInputSchema).inputSchema;

const variants = [
  ["live", workflow, runGate],
  ["pinned", pinnedWorkflow, runPinnedGate],
] as const;

for (const [name, variantWorkflow, runVariantGate] of variants) {
  describe(`sol issue train ${name} gate`, () => {
    test("defaults to the full root check set and accepts a run-specific override", () => {
      const inputSchema = inputSchemaOf(variantWorkflow);
      expect(inputSchema.parse({}).gateCommand).toBe(FULL_GATE_COMMAND);
      expect(inputSchema.parse({ gateCommand: "  true  " }).gateCommand).toBe("true");
      expect(() => inputSchema.parse({ gateCommand: "  " })).toThrow();
    });

    test("records the exact clean commit that passed", async () => {
      const root = fixture();
      try {
        const headSha = git(root, ["rev-parse", "HEAD"]);
        const result = await runVariantGate(root, 4, "true");

        expect(result.passed).toBe(true);
        expect(result.headSha).toBe(headSha);
        expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("refuses pre-existing uncommitted files without running the command", async () => {
      const root = fixture();
      const marker = join(dirname(root), `${name}-${Date.now()}-gate-ran`);
      try {
        writeFileSync(join(root, "stray.txt"), "uncommitted\n");
        const result = await runVariantGate(root, 5, `touch ${JSON.stringify(marker)}`);

        expect(result.passed).toBe(false);
        expect(result.summary).toContain("refused");
        expect(result.logTail).toContain("?? stray.txt");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(marker, { force: true });
      }
    });

    test("fails when the command dirties the committed tree", async () => {
      const root = fixture();
      try {
        const result = await runVariantGate(root, 6, "printf drift > generated.txt");

        expect(result.passed).toBe(false);
        expect(result.summary).toContain("left the committed tree dirty");
        expect(result.logTail).toContain("?? generated.txt");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
