/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { simulate } from "smthrs/testing";

setDefaultTimeout(60_000);

const workflows = join(import.meta.dir, "..", "workflows");
const workflowPath = (file: string) => join(workflows, file);
const load = async (file: string) => import(workflowPath(file));

type MockArgs = { nodeId: string; iteration: number };
type PlannedCase = {
  file: string;
  prefix: string;
  inputKey: "spec";
  defaultNeedle: string;
  panelistIds: string[];
};

const plannedCases: PlannedCase[] = [
  {
    file: "archive/issue-222-integrations-agent-callable-tool-catalog.tsx",
    prefix: "i222",
    inputKey: "spec",
    defaultNeedle: "buildAuthorizationUrl",
    panelistIds: ["i222:impl:review-panelist-0"],
  },
  {
    file: "archive/issue-491-review-cloud-hosted-walkthrough-lifecycl.tsx",
    prefix: "p491",
    inputKey: "spec",
    defaultNeedle: "/api/plan",
    panelistIds: ["p491:impl:review-panelist-0", "p491:impl:review-panelist-1"],
  },
  {
    file: "archive/issue-522-components-seven-composite-components-ar.tsx",
    prefix: "p522",
    inputKey: "spec",
    defaultNeedle: "ReviewLoop",
    panelistIds: ["p522:impl:review-panelist-0", "p522:impl:review-panelist-1"],
  },
];

function plannedMock({ nodeId, iteration }: MockArgs) {
  if (nodeId.endsWith(":plan")) return { plan: "PLAN_SENTINEL" };
  if (nodeId.endsWith(":implement")) {
    return { summary: `implementation-${iteration}`, filesChanged: ["current.ts"], allTestsPassing: true };
  }
  if (nodeId.endsWith(":validate")) {
    return iteration === 0
      ? { summary: "red", allPassed: false, failingSummary: "VALIDATION_SENTINEL" }
      : { summary: "green", allPassed: true, failingSummary: null };
  }
  if (nodeId.includes("review-panelist")) {
    return { reviewer: "current-panelist", approved: true, feedback: "current", issues: [] };
  }
  if (nodeId.endsWith("review-moderator")) {
    return { approved: iteration === 1, feedback: "current approval", issues: [] };
  }
  throw new Error(`Unexpected task: ${nodeId}`);
}

describe("issue workflow owner coverage", () => {
  test.each(plannedCases)(
    "$file reviews only the current green attempt",
    async ({ file, prefix, inputKey, defaultNeedle, panelistIds }) => {
      const module = await load(file);
      expect(module.inputSchema.parse({})[inputKey]).toContain(defaultNeedle);

      const sim = simulate(module.default, {
        input: { [inputKey]: "INPUT_SENTINEL" },
        mocks: { "*": plannedMock },
        workflowPath: workflowPath(file),
      });
      await sim.run();

      const implementId = `${prefix}:impl:implement`;
      const validateId = `${prefix}:impl:validate`;
      const moderatorId = `${prefix}:impl:review-moderator`;
      expect(sim.task(implementId).prompts).toHaveLength(2);
      expect(String(sim.task(implementId).prompts[0])).toContain("INPUT_SENTINEL");
      expect(String(sim.task(implementId).prompts[0])).toContain("PLAN_SENTINEL");
      expect(String(sim.task(implementId).prompts[1])).toContain("VALIDATION FAILED:\nVALIDATION_SENTINEL");

      const withoutPanelists = sim.executed.filter((id) => !id.includes("review-panelist"));
      expect(withoutPanelists).toEqual([
        `${prefix}:plan`,
        implementId,
        validateId,
        implementId,
        validateId,
        moderatorId,
      ]);
      const secondValidation = sim.executed.lastIndexOf(validateId);
      expect(sim.executed.findIndex((id) => id.includes(":review"))).toBeGreaterThan(secondValidation);
      for (const panelistId of panelistIds) expect(sim.executed).toContain(panelistId);
      expect(sim.task(moderatorId).outputs).toEqual([
        { approved: true, blocked: false, feedback: "current approval", issues: [] },
      ]);
      expect(sim.status).toBe("finished");
      expect(sim.unusedMocks).toEqual([]);
    },
  );

  test("issue 306 defaults to its real case08 request", async () => {
    const module = await load("archive/issue-306-audit-test-coverage-gaps-apps-gateway-ui.tsx");
    expect(module.inputSchema.parse({}).prompt).toContain("case08-inspector-real-product-path.test.ts");
  });

  test.each([
    { name: "green immediately", outcomes: [true], trace: 1, finalPassed: true },
    { name: "red then green", outcomes: [false, true], trace: 2, finalPassed: true },
    { name: "all red", outcomes: [false, false], trace: 2, finalPassed: false },
  ])("issue 306: $name", async ({ outcomes, trace, finalPassed }) => {
    const file = "archive/issue-306-audit-test-coverage-gaps-apps-gateway-ui.tsx";
    const module = await load(file);
    const sim = simulate(module.default, {
      input: { prompt: "INPUT_SENTINEL_306" },
      mocks: {
        "*": ({ nodeId, iteration }: MockArgs) => {
          if (nodeId.endsWith(":implement")) {
            return { summary: `implementation-${iteration}`, filesChanged: [], allTestsPassing: true };
          }
          if (nodeId.endsWith(":validate")) {
            const allPassed = outcomes[iteration] ?? outcomes.at(-1) ?? false;
            return {
              summary: allPassed ? "green" : `red-${iteration}`,
              allPassed,
              failingSummary: allPassed ? null : `FAILURE_${iteration}`,
            };
          }
          throw new Error(`Unexpected task: ${nodeId}`);
        },
      },
      workflowPath: workflowPath(file),
    });
    await sim.run();

    const implementId = "issue-306-cov:implement";
    const validateId = "issue-306-cov:validate";
    expect(sim.executed).toEqual(Array.from({ length: trace }, () => [implementId, validateId]).flat());
    expect(String(sim.task(implementId).prompts[0])).toContain("INPUT_SENTINEL_306");
    if (trace === 2) {
      expect(String(sim.task(implementId).prompts[1])).toContain("VALIDATION FAILED:\nFAILURE_0");
    }
    expect(sim.executed.some((id) => id.includes("review"))).toBe(false);
    expect(sim.output).toMatchObject({ allPassed: finalPassed });
    expect(sim.status).toBe("finished");
    expect(sim.unusedMocks).toEqual([]);
  });
});
