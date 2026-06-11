// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Eval Author
// smithers-description: Turn acceptance criteria into eval fixtures (JSONL cases + rubric) wired to smithers eval.
// smithers-tags: quality, evals
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import DerivePrompt from "../prompts/eval-author-derive.mdx";
import WritePrompt from "../prompts/eval-author-write.mdx";

const EVALS_DIR = ".smithers/evals";

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Describe the acceptance criteria / goal to turn into eval cases.")
    .describe("Acceptance criteria or goal to convert into eval fixtures."),
  workflow: z
    .string()
    .nullable()
    .default(null)
    .describe("Path or id of the workflow the eval suite targets. Null leaves a placeholder in the run command."),
});

// 1. The criteria, turned into a structured eval suite: a name plus a list of
//    cases the suite should cover. Each case pairs an input with the expected
//    assertion shape (status / output / outputContains) and a plain-text rubric.
const evalCaseSchema = z.looseObject({
  id: z.string().describe("Stable kebab-case id for this case."),
  input: z.looseObject({}).describe("The workflow input object this case runs with."),
  expected: z
    .looseObject({})
    .describe("Assertion object: status, output (exact), and/or outputContains (partial)."),
  rubric: z.string().describe("Plain-English pass/fail criteria for a human or judge reviewing this case."),
});

const derivedSuiteSchema = z.looseObject({
  suiteName: z.string().describe("Proposed kebab-case suite id (also the fixture filename stem)."),
  cases: z.array(evalCaseSchema).default([]).describe("Ordered eval cases covering the acceptance criteria."),
});

// 2. The fixture actually written to disk, plus the command to run it.
const writtenSuiteSchema = z.looseObject({
  path: z.string().describe("Path to the written .jsonl fixture."),
  caseCount: z.number().describe("Number of cases written to the fixture."),
  runCommand: z.string().describe("The smithers eval command to run the suite."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  derive: derivedSuiteSchema,
  write: writtenSuiteSchema,
});

export default smithers((ctx) => {
  const derive = ctx.outputMaybe("derive", { nodeId: "derive" });

  return (
    <Workflow name="eval-author">
      <Sequence>
        {/* 1 — Turn the acceptance criteria into a structured eval suite. */}
        <Task id="derive" output={outputs.derive} agent={agents.smart}>
          <DerivePrompt
            criteria={ctx.input.prompt ?? "Describe the acceptance criteria / goal to turn into eval cases."}
            workflow={ctx.input.workflow}
            evalsDir={EVALS_DIR}
          />
        </Task>

        {/* 2 — Write the JSONL fixture to disk and report the run command. */}
        {derive ? (
          <Task id="write" output={outputs.write} agent={agents.smartTool} heartbeatTimeoutMs={600_000}>
            <WritePrompt suite={derive} workflow={ctx.input.workflow} evalsDir={EVALS_DIR} />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
