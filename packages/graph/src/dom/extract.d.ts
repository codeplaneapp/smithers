import { ExtractOptions as ExtractOptions$1, WorkflowGraph, HostElement as HostElement$1, HostNode as HostNode$1, HostText as HostText$1, TaskDescriptor as TaskDescriptor$1, XmlNode as XmlNode$1 } from '../types.js';
import 'zod';
import '../ProofBinding.js';
import '../TaskSideEffect.js';
import '../TaskRevertContext.js';

/**
 * Test-only seam to override the dynamic runtime-module importer used by the
 * <Subflow>/<Sandbox> computeFns. Production behaviour is unchanged — the
 * default native `import()` importer is used unless a test overrides it — so the
 * heavy engine/sandbox packages those computeFns delegate to can be exercised
 * without loading them for real. Returns a restore function.
 * @param {(specifier: string) => Promise<any>} loader
 * @returns {() => void}
 */
declare function __setRuntimeModuleLoader(loader: (specifier: string) => Promise<any>): () => void;
/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {ExtractResult}
 */
declare function extractFromHost(root: HostNode | null, opts?: ExtractOptions): ExtractResult;
type HostElement = HostElement$1;
type HostText = HostText$1;
type ExtractOptions = ExtractOptions$1;
type ExtractResult = WorkflowGraph;
type HostNode = HostNode$1;
type TaskDescriptor = TaskDescriptor$1;
type XmlNode = XmlNode$1;

export { type ExtractOptions, type ExtractResult, type HostElement, type HostNode, type HostText, type TaskDescriptor, type XmlNode, __setRuntimeModuleLoader, extractFromHost };
