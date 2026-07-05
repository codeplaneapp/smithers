import { XmlNode, TaskDescriptor } from './types.js';
import 'zod';

type GraphSnapshot = {
    runId: string;
    frameNo: number;
    xml: XmlNode | null;
    tasks: TaskDescriptor[];
};

export type { GraphSnapshot };
