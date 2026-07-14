import { XmlNode, TaskDescriptor } from './types.js';
import 'zod';
import './ProofBinding.js';

type GraphSnapshot = {
    runId: string;
    frameNo: number;
    xml: XmlNode | null;
    tasks: TaskDescriptor[];
};

export type { GraphSnapshot };
