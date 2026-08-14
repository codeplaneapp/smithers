/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Control-plane assertion helpers for scenario runs (real SmithersDb / event log).
 */
/** Minimal adapter surface used by assertions (SmithersDb-compatible). */
type ScenarioAdapter = {
    listNodes(runId: string): unknown;
    listEventsByType?(runId: string, type: string): unknown;
    listSteers?(runId: string, query?: unknown): unknown;
    getRun?(runId: string): unknown;
};
declare function expectRunStatus(adapter: ScenarioAdapter, runId: string, status: string): Promise<void>;
declare function expectNodeState(adapter: ScenarioAdapter, runId: string, nodeId: string, state: string): Promise<void>;
declare function expectNodeStates(adapter: ScenarioAdapter, runId: string, expected: Record<string, string>): Promise<void>;
declare function tallyNodeStates(adapter: ScenarioAdapter, runId: string): Promise<{
    working: number;
    failed: number;
    done: number;
    blocked: number;
    other: number;
    total: number;
}>;
declare function expectSteerConsumed(adapter: ScenarioAdapter, runId: string, opts?: {
    nodeId?: string;
    minCount?: number;
}): Promise<void>;
declare function expectEventCount(adapter: ScenarioAdapter, runId: string, type: string, count: number): Promise<void>;
/**
 * Soft-pin / board-only oracle for opened tab labels (herdr or in-memory surface).
 */
declare function expectSoftPinBoard(openedNodeIds: string[], opts?: {
    workerPattern?: RegExp;
    maxStages?: number;
    mustInclude?: string[];
    mustExclude?: string[];
}): void;

export { type ScenarioAdapter, expectEventCount, expectNodeState, expectNodeStates, expectRunStatus, expectSoftPinBoard, expectSteerConsumed, tallyNodeStates };
