// Shared framework-wide constants to avoid drift between components,
// DOM extraction, scheduler, and engine layers.
export const DEFAULT_MERGE_QUEUE_CONCURRENCY = 1;
// Default scheduling priority stamped on a <MergeQueue> subtree (task priority
// defaults to 0; higher wins when runnable tasks compete for scarce
// concurrency slots). Well above 0 so that once ticket work is ready to land,
// landing takes precedence over starting new work. An explicit `priority`
// prop on the queue or on a descendant node still overrides it.
export const MERGE_QUEUE_PRIORITY = 1000;
// Centralized to keep component and extractor error messages in sync.
export const WORKTREE_EMPTY_PATH_ERROR = "<Worktree> requires a non-empty path prop";
