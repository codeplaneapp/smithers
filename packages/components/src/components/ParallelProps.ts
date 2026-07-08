import type React from "react";

export type ParallelProps = {
	id?: string;
	/** Display name for this group in run views (graph, /workflows mirror). */
	label?: string;
	maxConcurrency?: number;
	/**
	 * Opt-in subtree cap (int >= 1): at most this many DIRECT CHILDREN (whole
	 * subtrees, e.g. tickets) in flight at once. Unlike `maxConcurrency`, which
	 * caps leaf tasks whose innermost group is this parallel, it covers every
	 * descendant task. Both props may coexist.
	 */
	subtreeConcurrency?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
