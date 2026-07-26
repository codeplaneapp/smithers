import { ExtractOptions as ExtractOptions$1, HostNode as HostNode$1, TaskDescriptor as TaskDescriptor$1, WorkflowGraph as WorkflowGraph$1, XmlNode as XmlNode$1 } from './types.js';
import 'zod';
import './ProofBinding.js';
import './TaskSideEffect.js';
import './TaskRevertContext.js';

/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {WorkflowGraph}
 */
declare function extractGraph(root: HostNode | null, opts?: ExtractOptions): WorkflowGraph;
/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {WorkflowGraph}
 */
declare function extractFromHost(root: HostNode | null, opts?: ExtractOptions): WorkflowGraph;
type TaskDescriptor = TaskDescriptor$1;
type XmlNode = XmlNode$1;
type ExtractOptions = ExtractOptions$1;
type HostNode = HostNode$1;
type WorkflowGraph = WorkflowGraph$1;

export { type ExtractOptions, type HostNode, type TaskDescriptor, type WorkflowGraph, type XmlNode, extractFromHost, extractGraph };
