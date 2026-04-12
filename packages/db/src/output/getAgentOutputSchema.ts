import type { Table } from "drizzle-orm";
import { z } from "zod";
/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
export declare function getAgentOutputSchema(table: Table): z.ZodObject<any>;
