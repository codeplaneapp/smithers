import type { z } from "zod";

import type { SemanticToolCallResult } from "./SemanticToolCallResult.ts";
import type { SemanticToolName } from "./SemanticToolName.ts";

export type SemanticToolDefinition = {
    name: SemanticToolName;
    description: string;
    inputSchema: z.ZodTypeAny;
    outputSchema: z.ZodTypeAny;
    annotations: Record<string, boolean>;
    handler: (input: any) => Promise<SemanticToolCallResult>;
};
