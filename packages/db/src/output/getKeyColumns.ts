import type { AnyColumn, Table } from "drizzle-orm";
export declare function getKeyColumns(table: Table): {
    runId: AnyColumn;
    nodeId: AnyColumn;
    iteration?: AnyColumn;
};
