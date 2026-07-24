import { TaskMemoryConfig } from './types.js';
import 'zod';
import './ProofBinding.js';
import './TaskSideEffect.js';
import './TaskRevertContext.js';

/**
 * Validate and normalize every source of TaskDescriptor.memoryConfig.
 * Bank-based configurations receive the component defaults. Legacy-only
 * metadata remains accepted and preserved without activating runtime memory.
 *
 * @param {unknown} value
 * @returns {import("./types.ts").TaskMemoryConfig | undefined}
 */
declare function normalizeTaskMemoryConfig(value: unknown): TaskMemoryConfig | undefined;

export { normalizeTaskMemoryConfig };
