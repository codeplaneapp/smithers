import { TaskSideEffect } from './TaskSideEffect.js';
import './TaskRevertContext.js';

/**
 * Normalize the public boolean/object Task prop into the descriptor shape.
 *
 * @param {unknown} value
 * @returns {import("./TaskSideEffect.ts").TaskSideEffect | undefined}
 */
declare function normalizeTaskSideEffect(value: unknown): TaskSideEffect | undefined;

export { normalizeTaskSideEffect };
