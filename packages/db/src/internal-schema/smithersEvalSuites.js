import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `_smithers_eval_suites` — saved eval suites authored through the `evals`
 * gateway extension (`ext.evals.saveSuite`). A suite names a target workflow
 * and carries the canonical, already-parsed dataset (`EvalCaseInput[]`) the
 * `eval-suite-run` parent workflow fans out over when the suite is launched.
 *
 *  - `suiteId`        PK; minted on first save, stable across edits.
 *  - `name`           human-readable suite name.
 *  - `workflowKey`    the target workflow's discovered id (e.g. `hello`).
 *  - `workflowPath`   absolute path to the target workflow's entry file at
 *                     save time — pinned so a later suite edit or workflow
 *                     move cannot silently repoint an in-flight run.
 *  - `workflowRoot`   the approved root (`packDir ?? workspace root`) the
 *                     child workflow file must resolve inside of.
 *  - `datasetJson`    the canonical parsed dataset (`EvalCaseInput[]`), NOT
 *                     the raw authored text — the extension re-parses on
 *                     every save so a stored suite is always valid.
 *  - `caseCount`      `datasetJson`'s length, denormalized for `listSuites`.
 *  - `createdAtMs` / `updatedAtMs` — Unix epoch ms.
 */
export const smithersEvalSuites = sqliteTable("_smithers_eval_suites", {
  suiteId: text("suite_id").primaryKey(),
  name: text("name").notNull(),
  workflowKey: text("workflow_key").notNull(),
  workflowPath: text("workflow_path").notNull(),
  workflowRoot: text("workflow_root").notNull(),
  datasetJson: text("dataset_json").notNull(),
  caseCount: integer("case_count").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
