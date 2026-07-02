/** @jsxImportSource smithers-orchestrator */
import { Sandbox, Workflow } from "smithers-orchestrator";
import { z } from "zod";
import { createExampleSmithers } from "../_example-kit.js";
import {
	createMockVercelSandboxClient,
	createVercelSandboxProvider,
} from "./provider.js";

const { smithers, outputs } = createExampleSmithers({
	sandboxResult: z.object({
		summary: z.string(),
		remoteRunId: z.string(),
	}),
});

const mockVercelSandbox = createMockVercelSandboxClient(async ({ request }) => ({
	status: "finished",
	output: {
		summary: `Handled remotely: ${String(
			(request.input as { prompt?: unknown } | undefined)?.prompt ?? "no prompt",
		)}`,
		remoteRunId: `mock:${request.sandboxId}`,
	},
	runId: `mock:${request.sandboxId}`,
}));

const vercelSandboxProvider = createVercelSandboxProvider({
	vercelSandbox: mockVercelSandbox,
	runtime: "node24",
	timeout: 5 * 60_000,
	setupFiles: {
		"/vercel/sandbox/run-smithers-sandbox.js": {
			content: [
				"const fs = require('node:fs');",
				"const req = JSON.parse(fs.readFileSync('/vercel/sandbox/smithers-request.json', 'utf8'));",
				"fs.writeFileSync('/vercel/sandbox/smithers-result.json', JSON.stringify({",
				"  status: 'finished',",
				"  output: { summary: `Handled remotely: ${req.input?.prompt ?? 'no prompt'}`, remoteRunId: `vercel:${req.sandboxId}` },",
				"  runId: `vercel:${req.sandboxId}`",
				"}));",
			].join("\n"),
		},
	},
});

const remoteChildWorkflow = {
	build: () => <Workflow name="vercel-sandbox-child" />,
	opts: {},
};

export default smithers((ctx) => (
	<Workflow name="vercel-sandbox-provider-example">
		<Sandbox
			id="remote-edit"
			provider={vercelSandboxProvider}
			workflow={remoteChildWorkflow}
			input={{
				prompt:
					(ctx.input as { prompt?: unknown } | undefined)?.prompt ??
					"update the project",
			}}
			output={outputs.sandboxResult}
			reviewDiffs={false}
			retries={0}
		/>
	</Workflow>
));
