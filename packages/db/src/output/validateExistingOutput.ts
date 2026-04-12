import type { Table } from "drizzle-orm";
import { z } from "zod";
export declare function validateExistingOutput(table: Table, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
