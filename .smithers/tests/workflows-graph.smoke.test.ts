import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Construct smoke for the REAL ship-tickets + verifiable-goals workflows.
 *
 * `smithers graph` renders the workflow's JSX into its node graph WITHOUT
 * executing it (no agents, no git worktrees), so it's a fast, deterministic
 * check that the real `.tsx` imports, its schemas are valid, and every node the
 * monitoring UI depends on actually exists in the real workflow — catching any
 * drift between the workflow's node-id contract and the UI that reads it.
 *
 * Invoked as `bun run apps/cli/src/index.js graph …` (the CLI entry directly),
 * which bypasses the `smithers` shell-wrapper bin.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/index.js");
const workflowsDir = resolve(here, "../workflows");

function graph(workflow: string, input?: Record<string, unknown>): { code: number; out: string } {
  const args = ["run", cliEntry, "graph", workflow, "--format", "json"];
  if (input) args.push("--input", JSON.stringify(input));
  const r = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

test("ship-tickets workflow renders its full per-ticket node contract", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ship-tickets-graph-"));
  try {
    writeFileSync(join(tmp, "0001-sample.md"), "---\ntitle: Sample Goal\n---\n# Sample Goal\nBody.\n");
    const { code, out } = graph(join(workflowsDir, "ship-tickets.tsx"), { ticketsDir: tmp });
    expect(code).toBe(0);
    // Every node id the UI's STAGES + manifest read must exist in the real graph.
    for (const nodeId of [
      "manifest",
      "0001-sample:research",
      "0001-sample:plan",
      "0001-sample:implement",
      "0001-sample:validate",
      "0001-sample:review:0",
      "0001-sample:merge",
    ]) {
      expect(out).toContain(`"${nodeId}"`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 130_000);

test("verifiable-goals workflow renders without executing", () => {
  const { code, out } = graph(join(workflowsDir, "verifiable-goals.tsx"));
  expect(code).toBe(0);
  expect(out).toContain('"goals"');
  expect(out).toContain('"write"');
}, 130_000);
