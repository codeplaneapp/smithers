import { ExtractOptions as ExtractOptions$1, HostElement as HostElement$1, HostNode as HostNode$1, HostText as HostText$1, TaskDescriptor as TaskDescriptor$1, XmlNode as XmlNode$1 } from '../types.js';
import { ExtractResult as ExtractResult$1 } from '../ExtractResult.js';
import 'zod';

/**
 * @param {HostNode | null} root
 * @param {ExtractOptions} [opts]
 * @returns {ExtractResult}
 */
declare function extractFromHost(root: HostNode | null, opts?: ExtractOptions): ExtractResult;
type HostElement = HostElement$1;
type HostText = HostText$1;
type ExtractOptions = ExtractOptions$1;
type ExtractResult = ExtractResult$1;
type HostNode = HostNode$1;
type TaskDescriptor = TaskDescriptor$1;
type XmlNode = XmlNode$1;

export { type ExtractOptions, type ExtractResult, type HostElement, type HostNode, type HostText, type TaskDescriptor, type XmlNode, extractFromHost };
