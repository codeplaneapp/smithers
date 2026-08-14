import type { ScenarioAst } from "./ast.ts";
import { requiredCapabilities, type Capability } from "../harness/capabilities.ts";
export type CompileDiagnostic = Readonly<{ readonly code: string; readonly message: string; readonly node: string }>;
export type CompileResult = Readonly<
  | { readonly ok: true; readonly requiredCapabilities: readonly Capability[] }
  | {
      readonly ok: false;
      readonly diagnostics: readonly CompileDiagnostic[];
      readonly requiredCapabilities: readonly Capability[];
    }
>;
const validPairs = new Set([
  "task:before-task",
  "task:during-task",
  "task:after-task",
  "effect:before-task",
  "effect:during-task",
  "effect:after-effect-before-journal",
  "effect:after-journal-before-ack",
  "effect:after-ack",
  "attempt-write:before-task",
  "attempt-write:after-journal-before-ack",
  "event-append:before-task",
  "event-append:during-task",
  "event-append:after-task",
  "completion-cas:before-task",
  "completion-cas:after-journal-before-ack",
  "completion-cas:after-task",
  "heartbeat:during-task",
  "lease:during-task",
  "resume:before-task",
  "resume:during-task",
  "cancellation:during-task",
]);
export const compileScenario = (
  ast: ScenarioAst,
  registeredExtensions: ReadonlySet<string> = new Set(),
): CompileResult => {
  const diagnostics: CompileDiagnostic[] = [];
  const ids = new Set<string>();
  for (const step of ast.steps) {
    if (ids.has(step.id))
      diagnostics.push({ code: "DUPLICATE_STEP_ID", message: `duplicate step id ${step.id}`, node: step.id });
    ids.add(step.id);
  }
  const graph = new Map(ast.steps.map((s) => [s.id, s.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      diagnostics.push({ code: "DEPENDENCY_CYCLE", message: `dependency cycle includes ${id}`, node: id });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep))
        diagnostics.push({ code: "UNKNOWN_DEPENDENCY", message: `${id} depends on unknown step ${dep}`, node: id });
      else visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const barriers = new Set(ast.barriers.map((b) => b.id));
  for (const b of ast.barriers) {
    if (!Number.isInteger(b.budget) || b.budget < 1)
      diagnostics.push({ code: "INVALID_BARRIER_BUDGET", message: `barrier ${b.id} has invalid budget`, node: b.id });
    for (const party of b.parties)
      if (!ids.has(party))
        diagnostics.push({
          code: "UNKNOWN_BARRIER_PARTY",
          message: `barrier ${b.id} names unknown step ${party}`,
          node: b.id,
        });
    if (barriers.has(b.id) && ast.barriers.indexOf(b) !== ast.barriers.findIndex((x) => x.id === b.id))
      diagnostics.push({ code: "DUPLICATE_BARRIER_ID", message: `duplicate barrier id ${b.id}`, node: b.id });
  }
  for (const f of ast.faults)
    if (
      !validPairs.has(`${f.operation}:${f.phase}`) &&
      !(f.operation === "task" && ["before-task", "during-task", "after-task"].includes(f.phase))
    )
      diagnostics.push({
        code: "UNSUPPORTED_FAULT_CUT_POINT",
        message: `fault ${f.id} cannot target ${f.operation} at ${f.phase}`,
        node: f.id,
      });
  for (const ext of ast.extensions)
    if (!registeredExtensions.has(ext.name))
      diagnostics.push({
        code: "UNREGISTERED_EXTENSION",
        message: `extension ${ext.name} has no executor`,
        node: ext.name,
      });
  for (const step of ast.steps)
    if (step.extension && !registeredExtensions.has(step.extension))
      diagnostics.push({
        code: "UNREGISTERED_STEP_EXTENSION",
        message: `step ${step.id} references extension ${step.extension} with no executor`,
        node: step.id,
      });
  return diagnostics.length
    ? { ok: false, diagnostics, requiredCapabilities: requiredCapabilities(ast) }
    : { ok: true, requiredCapabilities: requiredCapabilities(ast) };
};
