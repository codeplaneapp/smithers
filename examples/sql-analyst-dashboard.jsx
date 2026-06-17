// @ts-nocheck
/**
 * <SqlAnalystDashboard> - Answer a business question with safe SQL and a chart.
 *
 * Pattern: schema discovery -> query plan -> SQL draft/check loop -> read-only
 * execution -> dashboard summary.
 * Use cases: BI agents, product analytics, revenue analysis, internal data tools,
 * natural-language analytics with deterministic safety gates.
 *
 * Smithers implementation: the SQL checker is its own persisted task, so unsafe
 * drafts do not silently execute. A human approval gate is available for risky
 * or repeatedly rejected queries.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import InspectSchemaPrompt from "./prompts/sql-analyst-dashboard/inspect-schema.mdx";
import PlanQueryPrompt from "./prompts/sql-analyst-dashboard/plan-query.mdx";
import WriteSqlPrompt from "./prompts/sql-analyst-dashboard/write-sql.mdx";
import CheckSqlPrompt from "./prompts/sql-analyst-dashboard/check-sql.mdx";
import ExecuteQueryPrompt from "./prompts/sql-analyst-dashboard/execute-query.mdx";
import MakeDashboardPrompt from "./prompts/sql-analyst-dashboard/make-dashboard.mdx";

const schemaMapSchema = z.object({
    tables: z.array(z.object({
        name: z.string(),
        columns: z.array(z.object({
            name: z.string(),
            type: z.string(),
            nullable: z.boolean().optional(),
        })),
        notes: z.string(),
    })),
    joins: z.array(z.string()),
});

const queryPlanSchema = z.object({
    question: z.string(),
    requiredTables: z.array(z.string()),
    metrics: z.array(z.string()),
    filters: z.array(z.string()),
    risks: z.array(z.string()),
});

const sqlDraftSchema = z.object({
    sql: z.string(),
    rowLimit: z.number(),
    explanation: z.string(),
});

const sqlCheckSchema = z.object({
    approved: z.boolean(),
    readOnly: z.boolean(),
    hasLimit: z.boolean(),
    risk: z.enum(["low", "medium", "high"]),
    safeSql: z.string(),
    rejectedReasons: z.array(z.string()),
});

const queryResultSchema = z.object({
    columns: z.array(z.string()),
    rowsPreview: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number(),
    executionMs: z.number(),
});

const approvalSchema = z.object({
    approved: z.boolean(),
    reviewer: z.string(),
    note: z.string(),
});

const dashboardSchema = z.object({
    answer: z.string(),
    chartSpec: z.object({
        type: z.enum(["table", "bar", "line", "scatter", "none"]),
        x: z.string().optional(),
        y: z.string().optional(),
        series: z.string().optional(),
    }),
    caveats: z.array(z.string()),
    sqlUsed: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
    schemaMap: schemaMapSchema,
    queryPlan: queryPlanSchema,
    sqlDraft: sqlDraftSchema,
    sqlCheck: sqlCheckSchema,
    queryResult: queryResultSchema,
    approval: approvalSchema,
    dashboard: dashboardSchema,
});

const schemaAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read, grep },
    instructions: `You are a database schema analyst. Inspect the available SQLite,
DuckDB, or warehouse schema and summarize tables, columns, join keys, and caveats.`,
});

const plannerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are an analytics planner. Convert the business question into a
query plan with required tables, metrics, filters, and data-quality risks.`,
});

const sqlAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, grep },
    instructions: `You are a SQL writer. Draft read-only SQL for the requested dialect.
Prefer CTEs, clear aliases, and explicit LIMIT clauses. Do not write mutating SQL.`,
});

const checkerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read },
    instructions: `You are a SQL safety checker. Reject INSERT, UPDATE, DELETE, DROP,
ALTER, CREATE, unsafe functions, missing LIMITs, and queries that ignore the plan.
Return a safe rewritten SQL query when possible.`,
});

const executorAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read },
    instructions: `You are a read-only query executor. Run only SQL approved by the
checker against the requested database. Capture columns, row count, preview rows,
and duration. Never execute mutating SQL.`,
});

const dashboardAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are a BI analyst. Turn query results into a concise answer,
chart spec, caveats, and the SQL used so a human can audit the result.`,
});

export default smithers((ctx) => {
    const latestCheck = ctx.outputMaybe("sqlCheck", { nodeId: "check-sql" });
    const querySafe = latestCheck?.approved === true && latestCheck?.readOnly === true && latestCheck?.hasLimit === true;
    const needsApproval = Boolean(latestCheck && (!latestCheck.approved || latestCheck.risk !== "low"));
    const approval = ctx.outputMaybe("approval", { nodeId: "approve-query" });
    const mayExecute = !needsApproval || approval?.approved === true;

    return (
        <Workflow name="sql-analyst-dashboard">
            <Sequence>
                <Task id="inspect-schema" output={outputs.schemaMap} agent={schemaAgent}>
                    <InspectSchemaPrompt
                        database={ctx.input.database ?? "fixtures/sql-analyst/orders.sqlite"}
                        dialect={ctx.input.dialect ?? "sqlite"}
                    />
                </Task>

                <Task id="plan-query" output={outputs.queryPlan} agent={plannerAgent}>
                    <PlanQueryPrompt
                        question={ctx.input.question ?? "Which acquisition channel has the highest 90-day gross margin, and is it trending up or down?"}
                        schemaMap={ctx.outputMaybe("schemaMap", { nodeId: "inspect-schema" })}
                    />
                </Task>

                <Loop
                    until={querySafe}
                    maxIterations={ctx.input.maxSqlAttempts ?? 3}
                    onMaxReached="return-last"
                >
                    <Sequence>
                        <Task id="write-sql" output={outputs.sqlDraft} agent={sqlAgent}>
                            <WriteSqlPrompt
                                queryPlan={ctx.outputMaybe("queryPlan", { nodeId: "plan-query" })}
                                schemaMap={ctx.outputMaybe("schemaMap", { nodeId: "inspect-schema" })}
                                dialect={ctx.input.dialect ?? "sqlite"}
                                rowLimit={ctx.input.rowLimit ?? 500}
                                previousCheck={latestCheck}
                            />
                        </Task>

                        <Task id="check-sql" output={outputs.sqlCheck} agent={checkerAgent}>
                            <CheckSqlPrompt
                                draft={ctx.outputMaybe("sqlDraft", { nodeId: "write-sql" })}
                                queryPlan={ctx.outputMaybe("queryPlan", { nodeId: "plan-query" })}
                                dialect={ctx.input.dialect ?? "sqlite"}
                                rowLimit={ctx.input.rowLimit ?? 500}
                            />
                        </Task>
                    </Sequence>
                </Loop>

                <Branch
                    if={needsApproval}
                    then={
                        <Approval
                            id="approve-query"
                            output={outputs.approval}
                            request={{
                                title: "Approve SQL analyst query",
                                summary: `SQL check risk ${latestCheck?.risk ?? "unknown"}; reasons: ${(latestCheck?.rejectedReasons ?? []).join(", ") || "none"}`,
                            }}
                        />
                    }
                    else={null}
                />

                <Task id="execute-query" output={outputs.queryResult} agent={executorAgent} skipIf={!mayExecute}>
                    <ExecuteQueryPrompt
                        database={ctx.input.database ?? "fixtures/sql-analyst/orders.sqlite"}
                        dialect={ctx.input.dialect ?? "sqlite"}
                        sql={latestCheck?.safeSql ?? ""}
                    />
                </Task>

                <Task id="make-dashboard" output={outputs.dashboard} agent={dashboardAgent}>
                    <MakeDashboardPrompt
                        question={ctx.input.question}
                        queryPlan={ctx.outputMaybe("queryPlan", { nodeId: "plan-query" })}
                        sqlCheck={latestCheck}
                        queryResult={ctx.outputMaybe("queryResult", { nodeId: "execute-query" })}
                        approval={approval}
                    />
                </Task>
            </Sequence>
        </Workflow>
    );
});
