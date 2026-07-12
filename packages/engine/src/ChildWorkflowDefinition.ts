import type { SmithersWorkflow } from "@smithers-orchestrator/components/SmithersWorkflow";
import type { ChildWorkflowFileRef } from "./ChildWorkflowFileRef.ts";

export type ChildWorkflowDefinition =
	| SmithersWorkflow<unknown>
	| (() => SmithersWorkflow<unknown> | unknown)
	| ChildWorkflowFileRef;
