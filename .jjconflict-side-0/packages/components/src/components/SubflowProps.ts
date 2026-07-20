import type React from "react";
import type { CachePolicy } from "@smithers-orchestrator/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers-orchestrator/scheduler/RetryPolicy";
import type { SmithersWorkflow } from "../SmithersWorkflow.ts";
import type { OutputTarget } from "./OutputTarget.ts";
import type { WorkflowFileRef } from "./WorkflowFileRef.ts";

export type SubflowProps = {
	id: string;
	/**
	 * The child workflow definition: a built workflow object, or a
	 * `{ path, approvedRoot? }` reference to a workflow module file generated
	 * at runtime (loaded from the approved root when the node executes).
	 */
	workflow: SmithersWorkflow<unknown> | WorkflowFileRef;
	/** Input to pass to the child workflow. */
	input?: unknown;
	/** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
	mode?: "childRun" | "inline";
	/**
	 * Where to store the subflow's result in the parent.
	 *
	 * In `"childRun"` mode the persisted value is the child's normalized
	 * `RunResult.output`: the row the child's last task wrote to the child's
	 * declared result schema (`smithers(build, { output })`, defaulting to the
	 * schema key literally named `output`), with the system columns (`runId`,
	 * `nodeId`, `iteration`) stripped. It is not a table-keyed snapshot of the
	 * child's output tables. Zero result rows normalize to `null`; exactly one
	 * row unwraps to that plain row object; multiple rows (several writers or
	 * loop iterations) persist as an array of rows. The value is validated
	 * against this target's schema like any task output, so adding or changing
	 * the child's final task changes the shape the parent must expect here.
	 */
	output: OutputTarget;
	skipIf?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	retries?: number;
	retryPolicy?: RetryPolicy;
	continueOnFail?: boolean;
	cache?: CachePolicy;
	/** Explicit dependency on other task node IDs. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
	children?: React.ReactNode;
};
