import { canonicalize } from "./scenario/canonicalize.ts";
import { replayIdentity } from "./scenario/replayIdentity.ts";
import { runScenario, type RunScenarioOptions } from "./runScenario.ts";
import type { ScenarioAst } from "./scenario/ast.ts";
import { compileScenario } from "./scenario/compile.ts";
import { makeReplayBundle } from "./replay/ReplayBundle.ts";
export const dryRun = (ast: ScenarioAst, options: RunScenarioOptions = {}) => { const seed = options.seed ?? ast.seed ?? 0; const controls = options.controlLog ?? []; const harness = options.harness; const compiled = compileScenario(ast, harness?.adapter?.extensions ?? new Set()); return { canonicalAst: canonicalize(ast), replayIdentity: replayIdentity({ ast, seed, controlLog: controls }), admissions: harness?.admitScenario(ast, options.capabilities ?? []) ?? [], diagnostics: compiled.ok ? [] : compiled.diagnostics, requiredCapabilities: compiled.requiredCapabilities, replayBundle: makeReplayBundle({ ast, seed, controlLog: controls, harness: harness?.name }), plannedSteps: ast.steps.map((step) => step.id), executesAgents: false, run: () => runScenario(ast, options) }; };
