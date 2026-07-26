// smithers-source: authored
// smithers-display-name: Run On Plue
// smithers-description: Run any Smithers workflow script on a real Microsandbox VM provisioned through the Plue CLI.
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers } from "smithers-orchestrator";
import { Sandbox } from "@smithers-orchestrator/components";
import { z } from "zod/v4";
import { createPlueSandboxProvider } from "../lib/plue-provider.ts";

/**
 * Run On Plue — the deliverable runner: hand it the path to ANY smithers
 * workflow `.tsx` file and it executes that script on plue infrastructure
 * (a real Microsandbox VM, provisioned and reached through the Plue CLI) instead of
 * locally. The remote run's mapped result becomes this workflow's output.
 *
 * `reviewDiffs` MUST stay `false`: the Sandbox default fails closed (pauses
 * for human diff review), which would hang an unattended remote run.
 *
 * Run:
 *   smithers up .smithers/workflows/run-on-plue.tsx --input \
 *     '{"script":".smithers/workflows/plue-demo-child.tsx","repo":"alice/smoke-test"}'
 */

const repoRoot = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url), "../../..");
  } catch {
    return process.cwd();
  }
})();

const inputSchema = z.object({
  /** Path (absolute or relative to the repo root) to the workflow .tsx to run remotely. */
  script: z.string(),
  /** Input passed through to the remote child workflow. */
  input: z.unknown().optional(),
  /** "owner/repo" the plue workspace is bound to. */
  repo: z.string(),
  /** Keep the plue workspace alive after the run instead of deleting it. */
  keepWorkspace: z.boolean().optional(),
  /** Path to the plue CLI binary (defaults to env PLUE_BIN or "plue"). */
  plueBin: z.string().optional(),
  /**
   * Reuse an existing (warm) plue workspace instead of creating one. Fresh
   * Cold boots take time; set this to a known-good workspace
   * id for deterministic runs. Never deleted on cleanup.
   */
  existingWorkspaceId: z.string().optional(),
});

const plueRunOutputSchema = z.object({
  status: z.enum(["finished", "failed", "cancelled"]),
  output: z.unknown().optional(),
  remoteRunId: z.string().optional(),
  workspaceId: z.string().optional(),
});

const { Workflow, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  output: plueRunOutputSchema,
});

export default smithers((ctx) => {
  const scriptArg = ctx.input.script ?? "";
  const scriptPath = scriptArg ? (isAbsolute(scriptArg) ? scriptArg : resolve(repoRoot, scriptArg)) : "";
  // ctx.input.script arrives null during graph rendering (no input supplied
  // yet) — fall back to placeholders so `smithers graph` can render the shape
  // without a real script path to read.
  let scriptSource = "";
  try {
    scriptSource = scriptPath ? readFileSync(scriptPath, "utf8") : "";
  } catch {
    scriptSource = "";
  }
  const scriptName = scriptPath ? basename(scriptPath) : "script.tsx";
  const repo = ctx.input.repo ?? "";
  const keepWorkspace = ctx.input.keepWorkspace ?? false;
  const plueBin = ctx.input.plueBin ?? undefined;
  const existingWorkspaceId = ctx.input.existingWorkspaceId ?? undefined;

  const provider = createPlueSandboxProvider({
    repo,
    keepWorkspace,
    plueBin,
    existingWorkspaceId,
  });

  // The engine only attaches a sandbox computeFn when a child `workflow` is
  // present (attachSandboxComputeFns skips the task otherwise and it would
  // execute as a static task with undefined output). The plue provider runs
  // the shipped script remotely and never calls executeChildWorkflow, so
  // this child is a formality because the provider executes the shipped source.
  const remoteChildWorkflow = {
    build: () => <Workflow name="plue-remote-child" />,
    opts: {},
  };

  return (
    <Workflow name="run-on-plue">
      <Sequence>
        <Sandbox
          id="plue-run"
          provider={provider}
          workflow={remoteChildWorkflow}
          input={{ scriptSource, scriptName, childInput: ctx.input.input ?? null }}
          reviewDiffs={false}
          timeoutMs={30 * 60_000}
          output={outputs.output}
        />
      </Sequence>
    </Workflow>
  );
});
