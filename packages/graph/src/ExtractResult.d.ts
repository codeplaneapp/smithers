import { XmlNode, TaskDescriptor } from './types.js';
import 'zod';
import './ProofBinding.js';

type ExtractResult = {
    xml: XmlNode | null;
    tasks: TaskDescriptor[];
    mountedTaskIds: string[];
};

export type { ExtractResult };
