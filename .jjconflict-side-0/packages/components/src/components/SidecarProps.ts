import type React from "react";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { ScorersMap } from "@smithers-orchestrator/graph/types";
import type { OutputTarget } from "./OutputTarget.ts";

export type SidecarProps = {
	id?: string;
	agent: AgentLike;
	sidecar: AgentLike;
	output: OutputTarget;
	sidecarOutput?: OutputTarget;
	scorers?: ScorersMap;
	prompt?: string | React.ReactNode;
	input?: string | React.ReactNode;
	maxConcurrency?: number;
	groundTruth?: unknown;
	context?: unknown;
	primaryLabel?: string;
	sidecarLabel?: string;
	skipIf?: boolean;
	children?: string | React.ReactNode;
};
