import type { Table } from "drizzle-orm";
export declare function buildOutputRow(table: Table, runId: string, nodeId: string, iteration: number, payload: unknown): {
    runId: string;
    nodeId: string;
    iteration: number;
    payload: any;
} | {
    runId: string;
    nodeId: string;
    iteration: number;
    payload?: undefined;
};
