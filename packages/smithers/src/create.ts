import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { SmithersAlertPolicy, SmithersWorkflowOptions } from "@smithers/scheduler/SmithersWorkflowOptions";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import React from "react";
import { Sequence as BaseSequence, Parallel as BaseParallel, MergeQueue as BaseMergeQueue, Branch as BaseBranch, Loop as BaseLoop, Ralph as BaseRalph, ContinueAsNew as BaseContinueAsNew, continueAsNew as baseContinueAsNew, Worktree as BaseWorktree, Timer as BaseTimer } from "@smithers/components";
import type { ApprovalProps, SandboxProps, SignalProps, WorkflowProps, TaskProps, DepsSpec } from "@smithers/components";
import type { z } from "zod";
type CreateSmithersOptions = {
    readableName?: string;
    description?: string;
    alertPolicy?: SmithersAlertPolicy;
    dbPath?: string;
    journalMode?: string;
};
/** Union of all Zod schema values registered in the schema, constrained to ZodObject. */
type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<any>>;
export type CreateSmithersApi<Schema = any> = {
    Workflow: (props: WorkflowProps) => React.ReactElement;
    Approval: <Row>(props: ApprovalProps<Row, SchemaOutput<Schema>>) => React.ReactElement;
    Task: <Row, D extends DepsSpec = {}>(props: TaskProps<Row, SchemaOutput<Schema>, D>) => React.ReactElement;
    Sequence: typeof BaseSequence;
    Parallel: typeof BaseParallel;
    MergeQueue: typeof BaseMergeQueue;
    Branch: typeof BaseBranch;
    Loop: typeof BaseLoop;
    Ralph: typeof BaseRalph;
    ContinueAsNew: typeof BaseContinueAsNew;
    continueAsNew: typeof baseContinueAsNew;
    Worktree: typeof BaseWorktree;
    Sandbox: (props: SandboxProps) => React.ReactElement;
    Signal: <Schema extends z.ZodObject<any>>(props: SignalProps<Schema>) => React.ReactElement;
    Timer: typeof BaseTimer;
    useCtx: () => SmithersCtx<Schema>;
    smithers: (build: (ctx: SmithersCtx<Schema>) => React.ReactElement, opts?: SmithersWorkflowOptions) => SmithersWorkflow<Schema>;
    db: BunSQLiteDatabase<any>;
    tables: {
        [K in keyof Schema]: any;
    };
    outputs: {
        [K in keyof Schema]: Schema[K];
    };
};
/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @example
 * ```ts
 * const { Workflow, Task, smithers, outputs } = createSmithers({
 *   discover: discoverOutputSchema,
 *   research: researchOutputSchema,
 * });
 *
 * export default smithers((ctx) => (
 *   <Workflow name="my-workflow">
 *     <Task id="discover" output={outputs.discover} agent={myAgent}>...</Task>
 *   </Workflow>
 * ));
 * ```
 */
export declare function createSmithers<Schemas extends Record<string, z.ZodObject<any>>>(schemas: Schemas, opts?: CreateSmithersOptions): CreateSmithersApi<Schemas>;
export {};
