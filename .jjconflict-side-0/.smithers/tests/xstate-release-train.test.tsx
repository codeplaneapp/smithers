import { describe, expect, test } from "bun:test";
import { computeMachineState, eventReceived, taskOutput } from "smithers-orchestrator/xstate";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow from "../workflows/xstate-release-train";
import { RELEASE_TRAIN_OUTPUTS, releaseTrainMachine } from "../components/releaseTrainMachine";

type Row = { nodeId: string; iteration: number; seq: number; payload?: unknown; [key: string]: unknown };

const ctx = (outputs: Record<string, Row[]>, signals: unknown[] = []) => ({
	runId: "xstate-test",
	outputRows: (output: unknown, options?: { nodeId?: string }) =>
		(outputs[String(output)] ?? [])
			.filter((row) => !options?.nodeId || row.nodeId === options.nodeId)
			.map((row) => ({ ...row, payload: row.payload ?? row })),
	signalRows: (name: string) => (name === "REVISE" ? signals : []),
});

const sources = [
	taskOutput(RELEASE_TRAIN_OUTPUTS.research, { nodeId: "research" }, () => ({ type: "RESEARCH_READY" })),
	taskOutput(RELEASE_TRAIN_OUTPUTS.approval, { nodeId: "approval" }, (row: { approved: boolean }) => ({
		type: row.approved ? "APPROVED" : "REJECTED",
	})),
	taskOutput(RELEASE_TRAIN_OUTPUTS.draft, {}, () => ({ type: "DRAFT_READY" })),
	eventReceived("REVISE", null, {}, () => ({ type: "REVISE" })),
];

const research: Row[] = [{ nodeId: "research", iteration: 0, seq: 1 }];
const approved: Row[] = [{ nodeId: "approval", iteration: 0, seq: 2, approved: true }];
const drafted: Row[] = [{ nodeId: "draft-r0", iteration: 0, seq: 3 }];

const fold = (outputs: Record<string, Row[]>, signals: unknown[] = [], id = "xstate-test") =>
	computeMachineState(ctx(outputs, signals), releaseTrainMachine, { id, input: {}, events: sources });

describe("xstate release train", () => {
	test("renders only the researching task on the first frame", async () => {
		const frame = await renderWorkflow(workflow, {
			workflowPath: `${import.meta.dir}/../workflows/xstate-release-train.tsx`,
			input: { topic: "launch" },
		});
		expect(frame.tasks.map((task: { nodeId: string }) => task.nodeId)).toEqual(["research"]);
	});

	test("folds durable rows through the approval into drafting", () => {
		expect(fold({ [RELEASE_TRAIN_OUTPUTS.research]: research }).matches("awaitingApproval")).toBe(true);
		expect(
			fold({ [RELEASE_TRAIN_OUTPUTS.research]: research, [RELEASE_TRAIN_OUTPUTS.approval]: approved }, [], "after-approval").matches("drafting"),
		).toBe(true);
	});

	test("a REVISE signal re-enters drafting and bumps the revision counter", () => {
		const revised = fold(
			{
				[RELEASE_TRAIN_OUTPUTS.research]: research,
				[RELEASE_TRAIN_OUTPUTS.approval]: approved,
				[RELEASE_TRAIN_OUTPUTS.draft]: drafted,
			},
			[{ signalName: "REVISE", payload: { feedback: "tighten" }, seq: 4, receivedAtMs: 0 }],
			"after-revision",
		);
		expect(revised.matches("drafting")).toBe(true);
		expect(revised.context.revision).toBe(1);
	});

	test("every re-enterable state versions its task id from context", () => {
		// A bare constant here would never re-execute on re-entry and would
		// deadlock the run, so both cycle states must derive their id.
		const drafting = releaseTrainMachine.states.drafting.meta?.smithersTaskId;
		const waiting = releaseTrainMachine.states.waitingForRevision.meta?.smithersTaskId;
		expect(typeof drafting).toBe("function");
		expect(typeof waiting).toBe("function");
		expect(drafting?.({ revision: 1 })).toBe("draft-r1");
		expect(waiting?.({ revision: 2 })).toBe("revise-r2");
	});
});
