/// <reference path="../types/bun-test-shim.d.ts" />
import { WorkflowDefinition } from '@smthrs/driver/WorkflowDefinition';

type CoverableWorkflow<Schema = unknown> = WorkflowDefinition<Schema> | {
    readonly default: WorkflowDefinition<Schema>;
};
type WorkflowCoverageApproval = {
    readonly approved: boolean;
    readonly note?: string;
    readonly decidedBy?: string;
    readonly optionKey?: string;
    readonly output?: unknown;
};
type WorkflowCoverageApprovalValue = boolean | "approve" | "deny" | WorkflowCoverageApproval;
type WorkflowCoverageApprovalResolver = (context: WorkflowCoverageTaskContext) => WorkflowCoverageApprovalValue | Promise<WorkflowCoverageApprovalValue>;
type WorkflowCoverageEventResolver = (context: WorkflowCoverageEventContext) => unknown | Promise<unknown>;
type WorkflowCoverageTaskContext = {
    readonly nodeId: string;
    readonly label?: string;
    readonly iteration: number;
    readonly input: unknown;
    readonly passIndex: number;
};
type WorkflowCoverageEventContext = WorkflowCoverageTaskContext & {
    readonly eventName: string;
    readonly correlationId?: string;
};
type WorkflowCoverageOptions = {
    readonly input?: unknown;
    readonly inputs?: readonly unknown[];
    readonly mocks?: Readonly<Record<string, unknown>>;
    readonly approvals?: WorkflowCoverageApprovalValue | WorkflowCoverageApprovalResolver | Readonly<Record<string, WorkflowCoverageApprovalValue | WorkflowCoverageApprovalResolver>>;
    readonly signals?: Readonly<Record<string, unknown | WorkflowCoverageEventResolver>>;
    readonly events?: Readonly<Record<string, unknown | WorkflowCoverageEventResolver>>;
    readonly maxLoopIterations?: number;
    readonly expectedNodes?: readonly string[];
    readonly allowUnreached?: readonly string[];
    readonly executeCompute?: boolean;
    readonly executeSideEffects?: boolean;
    readonly rootDir?: string;
    readonly workflowPath?: string | null;
    readonly assert?: boolean;
};
type WorkflowCoverageValidation = {
    readonly passIndex: number;
    readonly nodeId: string;
    readonly iteration: number;
    readonly valid: boolean;
    readonly message?: string;
};
type WorkflowCoverageDecision = {
    readonly passIndex: number;
    readonly nodeId: string;
    readonly iteration: number;
    readonly approved: boolean;
    readonly note?: string;
    readonly decidedBy?: string;
};
type WorkflowCoverageFailure = {
    readonly passIndex: number;
    readonly nodeId?: string;
    readonly code?: string;
    readonly message: string;
    readonly cause: unknown;
};
type WorkflowCoveragePass = {
    readonly passIndex: number;
    readonly input: unknown;
    readonly status: string;
    readonly executed: string[];
    readonly outputs: Record<string, unknown[]>;
    readonly taskOutputs: Record<string, unknown[]>;
    readonly finalOutput: unknown;
    readonly definedNodes: string[];
    readonly unexecuted: string[];
    readonly validations: WorkflowCoverageValidation[];
    readonly approvals: WorkflowCoverageDecision[];
    readonly errors: WorkflowCoverageFailure[];
    readonly unusedMocks: string[];
    readonly warnings: string[];
};
type WorkflowCoverageResult = {
    readonly status: "finished" | "failed";
    readonly passes: WorkflowCoveragePass[];
    readonly executed: string[];
    readonly outputs: Record<string, unknown[]>;
    readonly taskOutputs: Record<string, unknown[]>;
    readonly finalOutputs: unknown[];
    readonly definedNodes: string[];
    readonly coveredNodes: string[];
    readonly unexecuted: string[];
    readonly unreached: string[];
    readonly validations: WorkflowCoverageValidation[];
    readonly approvals: WorkflowCoverageDecision[];
    readonly errors: WorkflowCoverageFailure[];
    readonly allowUnreached: string[];
};
declare class WorkflowCoverageError extends Error {
    readonly result: WorkflowCoverageResult;
    constructor(message: string, result: WorkflowCoverageResult);
}
declare function coverWorkflow<Schema = unknown>(workflowModule: CoverableWorkflow<Schema>, options?: WorkflowCoverageOptions): Promise<WorkflowCoverageResult>;
declare function expectFullCoverage(result: WorkflowCoverageResult): WorkflowCoverageResult;

export { type CoverableWorkflow, type WorkflowCoverageApproval, type WorkflowCoverageApprovalResolver, type WorkflowCoverageApprovalValue, type WorkflowCoverageDecision, WorkflowCoverageError, type WorkflowCoverageEventContext, type WorkflowCoverageEventResolver, type WorkflowCoverageFailure, type WorkflowCoverageOptions, type WorkflowCoveragePass, type WorkflowCoverageResult, type WorkflowCoverageTaskContext, type WorkflowCoverageValidation, coverWorkflow, expectFullCoverage };
