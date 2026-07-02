// smithers-source: authored
// smithers-display-name: Run On Plue
// smithers-description: Run any smithers workflow script on plue infrastructure (a real Freestyle VM provisioned through the plue CLI) via the Sandbox component.
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers } from "smithers-orchestrator";
import { Sandbox } from "@smithers/components";
import { z } from "zod/v4";
import { createPlueSandboxProvider } from "../lib/plue-provider.ts";

/**
 * Run On Plue — the deliverable runner: hand it the path to ANY smithers
 * workflow `.tsx` file and it executes that script on plue infrastructure
 * (a real Freestyle VM, provisioned + SSH'd into via the plue CLI) instead of
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
	const scriptPath = scriptArg
		? isAbsolute(scriptArg)
			? scriptArg
			: resolve(repoRoot, scriptArg)
		: "";
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

	const provider = createPlueSandboxProvider({ repo, keepWorkspace, plueBin });

	return (
		<Workflow name="run-on-plue">
			<Sequence>
				<Sandbox
					id="plue-run"
					provider={provider}
					input={{ scriptSource, scriptName, childInput: ctx.input.input ?? null }}
					reviewDiffs={false}
					timeoutMs={30 * 60_000}
					output={outputs.output}
				/>
			</Sequence>
		</Workflow>
	);
});
