/**
 * The slideshow report spec: the fixed 14-slide deck the Context Engineering
 * Console produces to narrate a run end-to-end — from the user's original script,
 * through the agreed {@link ContextContract}, the workflow it ran, the gates it
 * passed, down to what to do next. {@link buildReport} fills every slide it can
 * from the contract (objective, non-goals, contract dump, questions/decisions,
 * tools/skills, gates, tests) and leaves a clear placeholder body on the slides
 * that only a real run can fill (artifacts produced, failures/retries, remaining
 * issues, the recommended next run, and any reusable skill/workflow harvested).
 *
 * Pure TS (no React, no clock, no randomness): the same script + contract always
 * yields the same deck, with exactly {@link REPORT_SLIDE_TITLES} slides in that
 * fixed order, so the deck can be built and unit-tested without a DOM.
 */

import type { ContextContract } from "./contextContract";

/** One slide of the report deck: a fixed title and its rendered body text. */
export type ReportSlide = {
  title: string;
  body: string;
};

/**
 * The 14 canonical slide titles, in deck order. {@link buildReport} always emits
 * exactly these slides, in this order. The first set is filled from the contract;
 * the trailing run-time-only slides (artifacts onward) carry a placeholder body
 * until a real run supplies their content.
 */
export const REPORT_SLIDE_TITLES: string[] = [
  "Original script",
  "Final objective",
  "User POV & non-goals",
  "Context contract",
  "Questions & decisions",
  "Workflow graph",
  "Tools/skills/sources",
  "Backpressure gates",
  "Tests/evals & results",
  "Artifacts",
  "Failures/retries",
  "Remaining issues",
  "Recommended next run",
  "Reusable skill/workflow",
];

/** Placeholder body for a slide whose content only a completed run can supply. */
const RUNTIME_PLACEHOLDER = "_Filled in after the run._";

/** Render a bullet list, or a fallback line when the list is empty. */
function bulletList(items: string[], emptyFallback: string): string {
  if (items.length === 0) {
    return emptyFallback;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

/** The "Original script" slide: the user's verbatim request. */
function buildOriginalScript(script: string): string {
  const trimmed = script.trim();
  return trimmed === "" ? "_No original script captured._" : trimmed;
}

/** The "Final objective" slide: the contract goal, with scope as supporting detail. */
function buildFinalObjective(contract: ContextContract): string {
  const goal = contract.goal.trim();
  const lines: string[] = [];
  lines.push(goal === "" ? "_No goal stated._" : goal);
  const scope = contract.scope.trim();
  if (scope !== "") {
    lines.push("");
    lines.push(`Scope: ${scope}`);
  }
  return lines.join("\n");
}

/** The "User POV & non-goals" slide: assumptions about the user plus explicit non-goals. */
function buildUserPovAndNonGoals(contract: ContextContract): string {
  const lines: string[] = [];
  lines.push("Assumptions:");
  lines.push(bulletList(contract.assumptions, "- _No assumptions recorded._"));
  lines.push("");
  lines.push("Non-goals:");
  lines.push(bulletList(contract.nonGoals, "- _No non-goals recorded._"));
  return lines.join("\n");
}

/** The "Context contract" slide: a compact dump of the agreed inputs, outputs, and memory. */
function buildContextContractSlide(contract: ContextContract): string {
  const inputs = contract.inputs.map(
    (input) => `${input.name} (${input.source ?? "unsourced"})`,
  );
  const memoryLines: string[] = [];
  if (contract.memory.persist.length > 0) {
    memoryLines.push(`Persist: ${contract.memory.persist.join("; ")}`);
  }
  if (contract.memory.doNotPersist.length > 0) {
    memoryLines.push(`Do not persist: ${contract.memory.doNotPersist.join("; ")}`);
  }
  const lines: string[] = [];
  lines.push("Inputs:");
  lines.push(bulletList(inputs, "- _No inputs declared._"));
  lines.push("");
  lines.push("Outputs:");
  lines.push(bulletList(contract.outputs, "- _No outputs declared._"));
  lines.push("");
  lines.push("Memory:");
  lines.push(bulletList(memoryLines, "- _No memory policy set._"));
  return lines.join("\n");
}

/** The "Questions & decisions" slide: decisions made and questions still open or deferred. */
function buildQuestionsAndDecisions(contract: ContextContract): string {
  const lines: string[] = [];
  lines.push("Decisions:");
  lines.push(bulletList(contract.decisions, "- _No decisions recorded._"));
  lines.push("");
  lines.push("Open questions:");
  lines.push(bulletList(contract.openQuestions, "- _None open._"));
  lines.push("");
  lines.push("Deferred questions:");
  lines.push(bulletList(contract.deferredQuestions, "- _None deferred._"));
  return lines.join("\n");
}

/** The "Tools/skills/sources" slide: the tools and skills the contract authorizes. */
function buildToolsSkillsSources(contract: ContextContract): string {
  const sources = contract.inputs
    .map((input) => input.source)
    .filter((source): source is string => source !== null);
  const lines: string[] = [];
  lines.push("Tools:");
  lines.push(bulletList(contract.tools, "- _No tools declared._"));
  lines.push("");
  lines.push("Skills:");
  lines.push(bulletList(contract.skills, "- _No skills declared._"));
  lines.push("");
  lines.push("Sources:");
  lines.push(bulletList(sources, "- _No input sources declared._"));
  return lines.join("\n");
}

/** The "Backpressure gates" slide: the acceptance criteria that gate the work. */
function buildBackpressureGates(contract: ContextContract): string {
  if (contract.acceptanceCriteria.length === 0) {
    return "_No backpressure gates defined._";
  }
  return contract.acceptanceCriteria
    .map((c) => {
      const kind = c.blocking ? "blocking" : "non-blocking";
      const method = c.verificationMethod ?? "unverified";
      return `- ${c.criterion} (${kind}, via ${method})`;
    })
    .join("\n");
}

/**
 * The "Tests/evals & results" slide: the acceptance criteria as a test plan, with
 * a placeholder result column an actual run fills in.
 */
function buildTestsEvalsAndResults(contract: ContextContract): string {
  const lines: string[] = [];
  if (contract.acceptanceCriteria.length === 0) {
    lines.push("_No tests or evals planned._");
  } else {
    lines.push("Planned checks:");
    for (const c of contract.acceptanceCriteria) {
      const method = c.verificationMethod ?? "unverified";
      lines.push(`- ${c.criterion} — ${method}`);
    }
  }
  lines.push("");
  lines.push(`Results: ${RUNTIME_PLACEHOLDER}`);
  return lines.join("\n");
}

/** Map every report slide title to the body it renders from the script + contract. */
const SLIDE_BUILDERS: Record<string, (script: string, contract: ContextContract) => string> = {
  "Original script": (script) => buildOriginalScript(script),
  "Final objective": (_script, contract) => buildFinalObjective(contract),
  "User POV & non-goals": (_script, contract) => buildUserPovAndNonGoals(contract),
  "Context contract": (_script, contract) => buildContextContractSlide(contract),
  "Questions & decisions": (_script, contract) => buildQuestionsAndDecisions(contract),
  "Workflow graph": () => RUNTIME_PLACEHOLDER,
  "Tools/skills/sources": (_script, contract) => buildToolsSkillsSources(contract),
  "Backpressure gates": (_script, contract) => buildBackpressureGates(contract),
  "Tests/evals & results": (_script, contract) => buildTestsEvalsAndResults(contract),
  Artifacts: () => RUNTIME_PLACEHOLDER,
  "Failures/retries": () => RUNTIME_PLACEHOLDER,
  "Remaining issues": () => RUNTIME_PLACEHOLDER,
  "Recommended next run": () => RUNTIME_PLACEHOLDER,
  "Reusable skill/workflow": () => RUNTIME_PLACEHOLDER,
};

/**
 * Build the full slideshow report from the user's original script and the agreed
 * contract. Always returns exactly {@link REPORT_SLIDE_TITLES.length} slides in
 * {@link REPORT_SLIDE_TITLES} order: the contract-derived slides are filled from
 * the contract (objective, non-goals, the contract dump, questions/decisions,
 * tools/skills/sources, gates, the test plan), and the run-time-only slides
 * (workflow graph, artifacts, failures/retries, remaining issues, next run, and
 * any reusable skill/workflow) carry a placeholder body until a real run fills
 * them. Deterministic per (script, contract) — no randomness, no I/O.
 */
export function buildReport(script: string, contract: ContextContract): ReportSlide[] {
  return REPORT_SLIDE_TITLES.map((title) => ({
    title,
    body: SLIDE_BUILDERS[title](script, contract),
  }));
}
