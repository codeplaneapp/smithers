// smithers-source: authored
// smithers-display-name: Plue Demo Child
// smithers-description: Tiny self-contained demo workflow shipped to a plue Freestyle VM by run-on-plue.tsx — one task answered by Claude, one by Codex.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

/**
 * Plue Demo Child — SELF-CONTAINED on purpose (no `../agents` import): this
 * is the exact file shipped verbatim to the remote VM by the plue sandbox
 * provider, so it must define its own env-authenticated agents and have no
 * dependency on anything outside this one file.
 *
 * Two trivial sequential tasks, minimal tokens: one answered by claude, one
 * by codex, so an e2e run of `run-on-plue` can assert both CLIs produced
 * real (non-templated) completions on the remote VM.
 */

const claude = new ClaudeCodeAgent({});
const codex = new CodexAgent({ skipGitRepoCheck: true });

const answerSchema = z.object({
	answer: z.string().describe("A short, direct answer."),
});

const outputSchema = z.object({
	claudeAnswer: z.string(),
	codexAnswer: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
	claudeStep: answerSchema,
	codexStep: answerSchema,
	output: outputSchema,
});

export default smithers((ctx) => {
	const claudeStep = ctx.outputMaybe("claudeStep", { nodeId: "ask-claude" });
	const codexStep = ctx.outputMaybe("codexStep", { nodeId: "ask-codex" });

	return (
		<Workflow name="plue-demo-child">
			<Sequence>
				<Task id="ask-claude" output={outputs.claudeStep} agent={claude}>
					What is 2 + 2? Answer with just the number.
				</Task>
				<Task id="ask-codex" output={outputs.codexStep} agent={codex}>
					What is the capital of France? Answer with just the city name.
				</Task>
				{claudeStep && codexStep ? (
					<Task id="output" output={outputs.output}>
						{() => ({ claudeAnswer: claudeStep.answer, codexAnswer: codexStep.answer })}
					</Task>
				) : null}
			</Sequence>
		</Workflow>
	);
});
