import type React from "react";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { PanelistConfig } from "./PanelistConfig.ts";
import type { OutputTarget } from "./OutputTarget.ts";

/** Extra Task props applied to a panel's generated tasks (panelists or moderator). */
export type PanelTaskOptions = {
	continueOnFail?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	retries?: number;
};

export type PanelProps = {
	id?: string;
	/**
	 * Panelists. Each entry is a single agent or a {@link PanelistConfig}. An
	 * entry may also be a failover CHAIN (`AgentLike[]`) passed through a cast:
	 * `normalizePanelist` treats a chain as one panelist whose task runs it as a
	 * failover sequence.
	 */
	panelists: PanelistConfig[] | AgentLike[];
	moderator: AgentLike;
	panelistOutput: OutputTarget;
	moderatorOutput: OutputTarget;
	strategy?: "synthesize" | "vote" | "consensus";
	minAgree?: number;
	maxConcurrency?: number;
	/** Extra Task props applied to every panelist task (e.g. continueOnFail, timeouts). */
	panelistTaskProps?: PanelTaskOptions;
	/** Extra Task props applied to the moderator task. */
	moderatorTaskProps?: PanelTaskOptions;
	skipIf?: boolean;
	children: string | React.ReactNode;
};
