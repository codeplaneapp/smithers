import { Hono } from "hono";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import { SmithersDb } from "@smithers/db/adapter";
export type ServeOptions = {
    workflow: SmithersWorkflow<any>;
    adapter: SmithersDb;
    runId: string;
    abort: AbortController;
    authToken?: string;
    metrics?: boolean;
};
export declare function createServeApp(opts: ServeOptions): Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
