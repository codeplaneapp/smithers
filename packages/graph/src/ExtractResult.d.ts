import { XmlNode, TaskDescriptor } from './types.js';
import 'zod';

type ExtractResult = {
    xml: XmlNode | null;
    tasks: TaskDescriptor[];
    mountedTaskIds: string[];
};

export type { ExtractResult };
