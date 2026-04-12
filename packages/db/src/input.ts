import type { Table } from "drizzle-orm";
import { z } from "zod";
export declare function validateInput(table: Table, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
