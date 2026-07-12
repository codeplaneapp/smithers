import type React from "react";

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
export type MergeQueueProps = {
	id?: string;
	maxConcurrency?: number;
	/**
	 * Scheduling priority inherited by descendant task nodes as their default.
	 * Defaults to MERGE_QUEUE_PRIORITY (1000, well above the task default of 0)
	 * so that once work is ready to land, landing outranks starting new work
	 * when runnable tasks compete for scarce concurrency slots. An explicit
	 * `priority` on a child node wins. Never overrides dependencies or caps.
	 */
	priority?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
