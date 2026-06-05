/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

import { implementerAgent, reviewerAgent } from "./components/agents.js";

/**
 * SWE-Bench Pro patch-generation workflow.
 *
 * Two frontier models collaborate on a real repository checkout (already pinned
 * to `base_commit` with history stripped by the runner):
 *
 *   implement — Claude Opus 4.8 reads the task spec, edits the source in place,
 *               and self-verifies with the repo's own build/test where it can.
 *   review    — Codex 5.5 independently audits the working-tree diff against the
 *               requirements/interface, rebuilds, and directly fixes any gaps.
 *
 * The agents never receive the hidden tests or the gold patch — only the
 * problem statement, behavioral requirements, and interface. The runner captures
 * the resulting `git diff` and scores it in the canonical Docker harness.
 */
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(
  {
    input: z.object({
      instanceId: z.string(),
      repoDir: z.string(),
      repo: z.string(),
      repoLanguage: z.string(),
      problemStatement: z.string(),
      requirements: z.string(),
      interface: z.string(),
    }),
    implement: z.object({
      summary: z.string(),
      filesChanged: z.array(z.string()),
      selfChecked: z.boolean(),
      notes: z.string(),
    }),
    review: z.object({
      summary: z.string(),
      verdict: z.enum(["approve", "revised"]),
      buildPassed: z.boolean(),
      remainingConcerns: z.array(z.string()),
    }),
  },
  { dbPath: process.env.SWEBP_DB_PATH ?? "smithers.db", readableName: "SWE-Bench Pro" },
);

/**
 * @param {import("./src/loadInstances.js").SwebpInstance | Record<string, any>} input
 */
function specBlock(input) {
  return [
    `Repository: ${input.repo} (${input.repoLanguage})`,
    "",
    "## Problem statement",
    input.problemStatement || "(none provided)",
    "",
    "## Requirements (the behavior your change MUST satisfy)",
    input.requirements || "(none provided)",
    "",
    "## Interface (signatures / file paths to create or modify)",
    input.interface || "(none provided)",
  ].join("\n");
}

const RULES = [
  "Rules:",
  "- Implement the smallest correct change that fully satisfies the requirements and interface.",
  "- Edit source files directly in the working directory.",
  "- You may build and run the project's existing tests to check yourself.",
  "- Do NOT search the web or fetch external solutions; reason from the code in front of you.",
  "- Do NOT weaken, delete, or special-case existing tests to make things pass.",
].join("\n");

export default smithers((ctx) => {
  const input = ctx.input;
  const agentOpts = { cwd: input.repoDir };

  const implementPrompt = [
    "You are a senior engineer fixing a real issue in this repository.",
    "",
    specBlock(input),
    "",
    RULES,
    "",
    "Make the change now. When done, report what you changed.",
  ].join("\n");

  const reviewPrompt = [
    "You are an independent reviewer. Another engineer just implemented a fix in this working directory.",
    "Inspect their changes with `git diff`, then judge them against the spec below.",
    "",
    specBlock(input),
    "",
    RULES,
    "",
    "Your job: rebuild/test as needed, and if the change is incomplete or incorrect,",
    "fix it directly in the working directory. Then report your verdict.",
  ].join("\n");

  return (
    <Workflow name="swe-bench-pro">
      <Sequence>
        <Task
          id="implement"
          output={outputs.implement}
          agent={implementerAgent(agentOpts)}
          timeoutMs={30 * 60 * 1000}
          retries={1}
          continueOnFail
        >
          {implementPrompt}
        </Task>
        <Task
          id="review"
          output={outputs.review}
          agent={reviewerAgent(agentOpts)}
          dependsOn={["implement"]}
          timeoutMs={30 * 60 * 1000}
          retries={1}
          continueOnFail
        >
          {reviewPrompt}
        </Task>
      </Sequence>
    </Workflow>
  );
});
