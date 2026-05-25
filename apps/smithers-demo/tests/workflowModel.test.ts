import { describe, expect, test } from "vitest";
import { generateSmithersCode, generateWorkflowFromPrompt } from "../src/workflowModel";

describe("workflow generation", () => {
  test("generates Smithers React code and workflow nodes from chat prompt", () => {
    const spec = generateWorkflowFromPrompt(
      "Research docs, implement a workflow generator, test it, and release it",
    );

    expect(spec.nodes.map((node) => node.id)).toEqual([
      "intake",
      "plan",
      "research",
      "implement",
      "document",
      "validate",
      "approval",
      "release",
    ]);

    const code = generateSmithersCode(spec);
    expect(code).toContain("<Workflow name=");
    expect(code).toContain('<Task id="validate"');
    expect(code).toContain('needs={{ implement: "implement" }}');
  });

  test("creates the required debate loop graph for the e2e prompt", () => {
    const spec = generateWorkflowFromPrompt(
      "Do a loop where you have two LMs debate communism versus capitalism and then have a judge LM output a final result.",
    );

    expect(spec.nodes.map((node) => node.id)).toEqual([
      "debate_loop",
      "capitalism_round_1",
      "communism_round_1",
      "capitalism_round_2",
      "communism_round_2",
      "judge_final",
    ]);
    expect(generateSmithersCode(spec)).toContain('id="judge_final"');
  });
});
