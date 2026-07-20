import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_eval_cases` — live per-case results for one `eval-suite-run`
 * parent run. The `plan` task seeds one `queued` row per dataset case up
 * front (so the results table is live from second zero); each case's own
 * `<Task>` upserts it to `running` then to a terminal status as its backing
 * child run settles. This is the honest, stable contract between the
 * WORKFLOW (writer) and the `evals` gateway extension (reader) — the
 * extension never reads a workflow's own output tables directly.
 *
 *  - `id`             PK; `${evalRunId}:${caseId}` (unique per parent run).
 *  - `evalRunId`      the parent `eval-suite-run` run's id.
 *  - `suiteId`        the suite this case belongs to (denormalized).
 *  - `caseId`         the dataset case id (stable across a suite's runs).
 *  - `caseIndex`      the case's position in the authored dataset — orders
 *                     `listCases` deterministically regardless of finish order.
 *  - `name`           optional case name (from `EvalCaseInput.name`).
 *  - `status`         `"queued" | "running" | "ok" | "failed" | "cancelled"` —
 *                     the CASE's own lifecycle (did its child run complete
 *                     without crashing), independent of whether its
 *                     assertions/scorers passed.
 *  - `caseRunId`      the real gateway run id backing this ONE case, once
 *                     its child workflow has been launched.
 *  - `inputJson` / `expectedJson` / `actualJson` / `assertionsJson` — JSON
 *                     blobs decoded by the `evals` extension's `listCases`.
 *  - `error`          a CASE-LEVEL failure message (the child run itself
 *                     errored/crashed) — distinct from a failed assertion.
 *  - `startedAtMs` / `finishedAtMs` / `durationMs`.
 */
export const smithersEvalCases = sqliteTable("_smithers_eval_cases", {
    id: text("id").primaryKey(),
    evalRunId: text("eval_run_id").notNull(),
    suiteId: text("suite_id").notNull(),
    caseId: text("case_id").notNull(),
    caseIndex: integer("case_index").notNull(),
    name: text("name"),
    status: text("status").notNull(),
    caseRunId: text("case_run_id"),
    inputJson: text("input_json"),
    expectedJson: text("expected_json"),
    actualJson: text("actual_json"),
    assertionsJson: text("assertions_json"),
    error: text("error"),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    durationMs: real("duration_ms"),
});
