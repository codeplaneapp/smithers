// smithers-source: user
// smithers-display-name: XState Release Train
/** @jsxImportSource smithers-orchestrator */
import { ApprovalGate, Task, UI, WaitForEvent, createSmithers } from "smithers-orchestrator";
import { approvalDecided, eventReceived, taskOutput, timedOut, useSmithersMachine } from "smithers-orchestrator/xstate";
import { z } from "zod/v4";
import { agents } from "../agents";
import { RELEASE_TRAIN_OUTPUTS, releaseTrainMachine } from "../components/releaseTrainMachine";

const inputSchema = z.object({
	topic: z.string().default("Smithers 0.29.0: durable XState folds"),
	audience: z.string().default("workflow engineers"),
});

const researchSchema = z.object({ summary: z.string(), findings: z.array(z.string()) });
const approvalSchema = z.object({ approved: z.boolean(), note: z.string().optional() });
const draftSchema = z.object({ draft: z.string(), claims: z.array(z.string()) });
const waitSchema = z.object({ kind: z.enum(["signal", "timeout"]), payload: z.unknown().optional() });
const reviseSchema = z.object({ feedback: z.string().default("Tighten the proof of durability.") });

const { Workflow, smithers, outputs, useCtx } = createSmithers({
	input: inputSchema,
	releaseResearch: researchSchema,
	releaseApproval: approvalSchema,
	releaseDraft: draftSchema,
	releaseWait: waitSchema,
});

function ReleaseTrain() {
	const ctx = useCtx();

	// Nothing about the machine is persisted. Each frame it is refolded from the
	// durable output, approval, signal, and timeout rows below — which is why
	// resume, fork, and rewind all reconstruct it for free.
	const state = useSmithersMachine(releaseTrainMachine, {
		id: "release-train",
		input: ctx.input,
		events: [
			taskOutput(RELEASE_TRAIN_OUTPUTS.research, { nodeId: "research" }, () => ({ type: "RESEARCH_READY" })),
			approvalDecided(RELEASE_TRAIN_OUTPUTS.approval, { nodeId: "approval" }, (decision: { approved: boolean; note?: string }) => ({
				type: decision.approved ? "APPROVED" : "REJECTED",
				note: decision.note,
			})),
			taskOutput(RELEASE_TRAIN_OUTPUTS.draft, {}, () => ({ type: "DRAFT_READY" })),
			eventReceived("REVISE", reviseSchema, {}, (payload: { feedback?: string }) => ({ type: "REVISE", feedback: payload.feedback })),
			// No nodeId: the wait node id is revision-versioned, so match the whole table.
			timedOut(RELEASE_TRAIN_OUTPUTS.wait, {}, () => ({ type: "TIMEOUT" })),
		],
	});

	const revision = state.context.revision;

	return (
		<>
			{state.matches("researching") ? (
				<Task id="research" output={outputs.releaseResearch} agent={agents.cheapFast} timeoutMs={120_000}>
					Research {ctx.input.topic} for {ctx.input.audience}. Return five concrete findings and a concise summary.
				</Task>
			) : null}

			{state.matches("awaitingApproval") ? (
				<ApprovalGate
					id="approval"
					output={outputs.releaseApproval}
					when
					onDeny="continue"
					request={{
						title: "Approve the release narrative",
						summary: "Review the research before drafting the launch thread.",
					}}
				/>
			) : null}

			{/* Both ids are versioned from the machine's assign counter. A bare constant
			    here would never re-execute on re-entry and would deadlock the run. */}
			{state.matches("drafting") ? (
				<Task id={`draft-r${revision}`} output={outputs.releaseDraft} agent={agents.cheapFast} timeoutMs={120_000}>
					Draft a launch-thread narrative for {ctx.input.topic}. Incorporate the research, cite the durable fold, and return a polished draft.
				</Task>
			) : null}

			{state.matches("waitingForRevision") ? (
				<WaitForEvent
					id={`revise-r${revision}`}
					event="REVISE"
					output={outputs.releaseWait}
					outputSchema={waitSchema}
					timeoutMs={45_000}
					onTimeout="continue"
					tagged
					label="Waiting for editorial revision"
				/>
			) : null}
		</>
	);
}

export default smithers(() => (
	<Workflow name="xstate-release-train">
		<UI entry="../ui/xstate-release-train.tsx" title="XState Release Train" />
		<ReleaseTrain />
	</Workflow>
));
