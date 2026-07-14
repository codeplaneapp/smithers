import { TaskDescriptor as TaskDescriptor$1 } from './types.js';
import 'zod';
import './ProofBinding.js';

/**
 * Validate `<Task fork>` references across the extracted task list. Throws a
 * typed SmithersError for fork sources that can never resolve to a usable
 * session snapshot, so authoring mistakes fail fast at graph-build time rather
 * than deadlocking the scheduler.
 *
 * Detects:
 *   - TASK_FORK_SOURCE_NOT_FOUND — fork id absent from the graph (covers a
 *     source that only exists in an unselected branch).
 *   - TASK_FORK_SESSION_UNAVAILABLE — the forking task is not an agent task and
 *     therefore has no session to seed.
 *   - TASK_FORK_CYCLE — the fork edge closes a dependency cycle, directly or
 *     indirectly (via `dependsOn` and/or other fork edges).
 *
 * Loop semantics are intentionally not validated here: `fork` resolves to the
 * latest completed snapshot for a task id at execution time, so a source inside
 * a loop is valid as long as its logical id appears in the graph.
 *
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {void}
 */
declare function validateForkSources(tasks: readonly TaskDescriptor[]): void;
type TaskDescriptor = TaskDescriptor$1;

export { type TaskDescriptor, validateForkSources };
