import { ClaudeWorkflowNodeKind as ClaudeWorkflowNodeKind$1 } from './ClaudeWorkflowNodePhase.js';
import { TaskDescriptor as TaskDescriptor$1 } from './types.js';
import 'zod';

/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodeKind} ClaudeWorkflowNodeKind */
/**
 * Classify a task descriptor into the Claude Code /workflows node kind.
 *
 * Shared by the live derivation (`deriveClaudeWorkflowPhases`, over a
 * GraphSnapshot) and the engine's frame persistence (`persistDriverFrame`
 * stamps this onto the frame task index) so that the persisted `kind` a LIVE
 * run reads back via `deriveClaudeWorkflowPhasesFromFrame` matches the live
 * classification for every node type — including timer/wait/subflow/sandbox and
 * a childless approval gate, which `task.kind` alone does not capture.
 *
 * @param {TaskDescriptor} task
 * @returns {ClaudeWorkflowNodeKind}
 */
declare function classifyClaudeWorkflowNodeKind(task: TaskDescriptor): ClaudeWorkflowNodeKind;
type TaskDescriptor = TaskDescriptor$1;
type ClaudeWorkflowNodeKind = ClaudeWorkflowNodeKind$1;

export { type ClaudeWorkflowNodeKind, type TaskDescriptor, classifyClaudeWorkflowNodeKind };
