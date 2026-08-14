export type SmithersAlertSeverity = "info" | "warning" | "critical";

export type SmithersAlertLabels = Record<string, string>;

export type SmithersAlertReactionKind = "emit-only" | "pause" | "cancel" | "open-approval" | "deliver";

export type SmithersAlertReaction =
  | { kind: "emit-only" }
  | { kind: "pause" }
  | { kind: "cancel" }
  | { kind: "open-approval" }
  | { kind: "deliver"; destination: string };

export type SmithersAlertReactionRef = string | SmithersAlertReaction;

export type SmithersAlertPolicyDefaults = {
  owner?: string;
  severity?: SmithersAlertSeverity;
  runbook?: string;
  labels?: SmithersAlertLabels;
};

export type SmithersAlertPolicyRule = SmithersAlertPolicyDefaults & {
  afterMs?: number;
  reaction?: SmithersAlertReactionRef;
};

export type SmithersAlertPolicy = {
  defaults?: SmithersAlertPolicyDefaults;
  rules?: Record<string, SmithersAlertPolicyRule>;
  reactions?: Record<string, SmithersAlertReaction>;
};

/**
 * Where a workflow's `RunResult.output` rows are read from. Mirrors the
 * component-level `OutputTarget` union (see `@smthrs/components`
 * `OutputTarget`), restated locally because `@smthrs/scheduler`
 * is a pure decision engine that must not depend on zod or components:
 *
 * - a Zod schema object registered via `createSmithers(...).outputs.<key>` (recommended),
 * - a Drizzle table object, or
 * - a string schema key (escape hatch).
 */
export type SmithersWorkflowOutputTarget =
  | { readonly _def: unknown }
  | { readonly $inferSelect: Record<string, unknown> }
  | string;

export type SmithersWorkflowOptions = {
  alertPolicy?: SmithersAlertPolicy;
  cache?: boolean;
  /**
   * Per-workflow opt-out for the default-on post-failure autopsy. When `false`,
   * a failure of this workflow never auto-launches the `post-failure` autopsy —
   * use it for workflows that fail deliberately (e.g. fault-injection e2e
   * suites) so they don't burn agent tokens autopsying an expected failure.
   * Defaults to on. The CLI's `--no-post-failure` flag and `SMITHERS_POST_FAILURE=0`
   * env var remain independent, broader opt-outs.
   */
  postFailureAutopsy?: boolean;
  /**
   * Explicit workflow-level output schema/table used to populate
   * `RunResult.output` (and therefore a parent `Subflow`'s child result). Pass
   * a `createSmithers(...).outputs.<key>` schema, a Drizzle table, or a string
   * schema key. Defaults to the child schema key literally named `output`.
   */
  output?: SmithersWorkflowOutputTarget;
  workflowHash?: string;
};
