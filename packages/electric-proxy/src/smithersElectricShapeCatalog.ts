import type { GatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";

export type SmithersElectricShapeDefinition = {
  name: string;
  table: string;
  requiredScope: GatewayScope;
  whereTemplate?: string;
  runIdColumn?: string;
  workspaceIdColumn?: string;
  userPrivateColumn?: string;
  tablePattern?: RegExp;
  description?: string;
};

export const smithersElectricShapeCatalog: readonly SmithersElectricShapeDefinition[] = [
  {
    name: "runs",
    table: "_smithers_runs",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Run summaries and per-run records.",
  },
  {
    name: "nodes",
    table: "_smithers_nodes",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Per-run node state.",
  },
  {
    name: "attempts",
    table: "_smithers_attempts",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Per-run attempt rows.",
  },
  {
    name: "events",
    table: "_smithers_events",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Per-run event log rows.",
  },
  {
    name: "approvals",
    table: "_smithers_approvals",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Human approval requests and decisions.",
  },
  {
    name: "node_diffs",
    table: "_smithers_node_diffs",
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: "Cached node DiffBundle rows.",
  },
  {
    name: "docs",
    table: "_smithers_docs",
    requiredScope: "run:read",
    description: "DB-backed tickets, plans, specs, and proposals.",
  },
] as const;

/**
 * Build a run-scoped shape entry for one workflow output table. Output tables
 * are NOT a regex catch-all (that would expose any identifier-named table that
 * happens to carry a `run_id` column); the proxy must be handed the explicit
 * allowlist of real output-table names — derived from the output-table
 * registry — so only enumerated tables are reachable, each still scoped by
 * `run_id IN ({run_ids})`.
 */
export function outputTableShape(table: string): SmithersElectricShapeDefinition {
  return {
    name: `output:${table}`,
    table,
    requiredScope: "run:read",
    runIdColumn: "run_id",
    whereTemplate: "run_id IN ({run_ids})",
    description: `Workflow output table ${table}, scoped by run_id.`,
  };
}

/**
 * Compose the base `_smithers_*` shape catalog with explicit per-table entries
 * for the supplied output-table allowlist. Passing `[]` (the default) means no
 * output table is reachable at all.
 */
export function smithersElectricCatalogWithOutputTables(
  outputTables: readonly string[],
): readonly SmithersElectricShapeDefinition[] {
  if (outputTables.length === 0) return smithersElectricShapeCatalog;
  const seen = new Set<string>();
  const extra: SmithersElectricShapeDefinition[] = [];
  for (const table of outputTables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || seen.has(table)) continue;
    seen.add(table);
    extra.push(outputTableShape(table));
  }
  return [...smithersElectricShapeCatalog, ...extra];
}
