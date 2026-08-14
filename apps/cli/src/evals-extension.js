import { randomUUID } from "node:crypto";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { parseEvalDataset } from "@smthrs/scorers/evalCases";
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./DiscoveredWorkflow.ts").DiscoveredWorkflow} DiscoveredWorkflow */

/**
 * The `evals` gateway extension (issue #77): the missing server half of
 * multi's already-shipped eval-suite client. Pure wiring on top of
 * `GatewayExtensions` (see `packages/server/src/GatewayExtensions.js`) — the
 * only novel behavior lives here (persistence via `SmithersDb`, dataset
 * validation via `@smthrs/scorers/evalCases`, and case-row
 * composition for `listCases`).
 *
 * Wire contract (must match multi's `src/evals/{EvalsBridge.tsx,
 * evalsStore.ts,evalReport.ts}` exactly — see AGENTS.md-style plan for
 * issue #77):
 *   - `ext.evals.listSuites` (resource, run:read)  params `{}`            → bare `EvalSuiteSummary[]`
 *   - `ext.evals.saveSuite`  (action,   run:write) params `{suiteId?, name, workflowKey, datasetText}` → `{suiteId}`
 *   - `ext.evals.listCases`  (resource, run:read)  params `{evalRunId}`   → bare `EvalCaseResult[]`
 *
 * Launching a suite is NOT an extension call — the client starts the seeded
 * `eval-suite-run` parent workflow through the normal `launchRun` RPC.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   resolveWorkflowKey: (key: string) => DiscoveredWorkflow | undefined;
 *   workspace: string;
 * }} deps
 * @returns {import("@smthrs/server/GatewayExtensions").GatewayExtensionDefinition}
 */
export function createEvalsExtension({ adapter, resolveWorkflowKey, workspace }) {
  return {
    title: "Eval Suites",
    description:
      "Author eval suites, launch them as real gateway runs (eval-suite-run), and stream live per-case results and scores.",
    resources: {
      listSuites: {
        scope: "run:read",
        title: "List saved eval suites",
        handler: async () => {
          const rows = await adapter.listEvalSuites();
          return rows.map((row) => ({
            suiteId: row.suiteId,
            name: row.name,
            workflowKey: row.workflowKey,
            caseCount: row.caseCount,
            updatedAtMs: row.updatedAtMs,
          }));
        },
      },
      listCases: {
        scope: "run:read",
        title: "Live per-case results for one eval-suite-run",
        handler: async (params) => {
          const evalRunId = typeof params?.evalRunId === "string" ? params.evalRunId.trim() : "";
          if (!evalRunId) {
            // Honest empty, never an error — an unknown/absent evalRunId is
            // exactly what a not-yet-launched suite (or a stale link) looks
            // like; multi's `joinEvalCases` renders the authored dataset as
            // queued placeholders in that case.
            return [];
          }
          const [caseRows, scorerRows, run] = await Promise.all([
            adapter.listEvalCaseResults(evalRunId),
            adapter.listScorerResults(evalRunId),
            adapter.getRun(evalRunId),
          ]);
          if (caseRows.length === 0) {
            return [];
          }
          /** @type {Map<string, Array<{ scorer: string; score: number; reason?: string }>>} */
          const scorerVerdictByNode = new Map();
          for (const scorerRow of scorerRows) {
            const list = scorerVerdictByNode.get(scorerRow.nodeId) ?? [];
            list.push({
              scorer: scorerRow.scorerName,
              score: scorerRow.score,
              ...(scorerRow.reason ? { reason: scorerRow.reason } : {}),
            });
            scorerVerdictByNode.set(scorerRow.nodeId, list);
          }
          // Reconcile: an eval run that reached a terminal (failed/cancelled)
          // state can never bring its still-in-flight cases home — report them
          // as cancelled so the client's roll-up never spins forever.
          const runIsTerminal = Boolean(run) && (run.status === "failed" || run.status === "cancelled");
          return caseRows.map((row) => {
            const inFlight = row.status === "queued" || row.status === "running";
            const status = runIsTerminal && inFlight ? "cancelled" : row.status;
            const scorerVerdict = scorerVerdictByNode.get(`case-${row.caseId}`);
            return {
              caseId: row.caseId,
              ...(row.name ? { name: row.name } : {}),
              status,
              ...(row.caseRunId ? { caseRunId: row.caseRunId } : {}),
              ...(row.inputJson != null ? { input: decodeJsonField(row.inputJson) } : {}),
              ...(row.expectedJson != null ? { expected: decodeJsonField(row.expectedJson) } : {}),
              ...(row.actualJson != null ? { actual: decodeJsonField(row.actualJson) } : {}),
              ...(row.assertionsJson != null ? { assertions: decodeJsonField(row.assertionsJson) ?? [] } : {}),
              ...(scorerVerdict ? { scorerVerdict } : {}),
              ...(typeof row.durationMs === "number" ? { durationMs: row.durationMs } : {}),
              ...(row.error ? { error: row.error } : {}),
            };
          });
        },
      },
    },
    actions: {
      saveSuite: {
        scope: "run:write",
        title: "Save (create or update) an eval suite",
        handler: async (params) => {
          const name = typeof params?.name === "string" ? params.name.trim() : "";
          if (!name) {
            throw new SmithersError("INVALID_INPUT", "Give the suite a name.");
          }
          const workflowKey = typeof params?.workflowKey === "string" ? params.workflowKey.trim() : "";
          if (!workflowKey) {
            throw new SmithersError("INVALID_INPUT", "Give the suite a target workflow key to run cases against.");
          }
          const discovered = resolveWorkflowKey(workflowKey);
          if (!discovered) {
            throw new SmithersError("INVALID_INPUT", `No workflow named ${workflowKey} in this workspace.`, {
              workflowKey,
            });
          }
          const datasetText = typeof params?.datasetText === "string" ? params.datasetText : "";
          const parsed = parseEvalDataset(datasetText);
          if (!parsed.ok) {
            throw new SmithersError("INVALID_INPUT", parsed.error);
          }
          if (parsed.cases.length === 0) {
            throw new SmithersError("INVALID_INPUT", "Dataset has no cases.");
          }
          const suiteId =
            typeof params?.suiteId === "string" && params.suiteId.trim() !== "" ? params.suiteId.trim() : randomUUID();
          const existing = await adapter.getEvalSuite(suiteId);
          const now = Date.now();
          await adapter.upsertEvalSuite({
            suiteId,
            name,
            workflowKey,
            workflowPath: discovered.entryFile,
            workflowRoot: discovered.packDir ?? workspace,
            datasetJson: JSON.stringify(parsed.cases),
            caseCount: parsed.cases.length,
            createdAtMs: existing?.createdAtMs ?? now,
            updatedAtMs: now,
          });
          return { suiteId };
        },
      },
    },
  };
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function decodeJsonField(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
