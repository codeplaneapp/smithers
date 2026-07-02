import type React from "react";

export type ParallelProps = {
	id?: string;
	/** Display name for this group in run views (graph, /workflows mirror). */
	label?: string;
	maxConcurrency?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
