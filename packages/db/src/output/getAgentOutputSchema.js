import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
export function getAgentOutputSchema(table) {
    const baseSchema = createInsertSchema(table);
    // Remove the key columns that smithers populates automatically
    const shape = baseSchema.shape;
    const { runId, nodeId, iteration, ...rest } = shape;
    return z.object(rest);
}
