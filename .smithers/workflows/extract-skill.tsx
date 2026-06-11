// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Extract Skill
// smithers-description: After a run, harvest a reusable skill or workflow and durable memory from the pattern.
// smithers-tags: reuse, skills, memory
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import AnalyzePrompt from "../prompts/extract-skill-analyze.mdx";
import ProposePrompt from "../prompts/extract-skill-propose.mdx";
import ScaffoldSkillPrompt from "../prompts/extract-skill-scaffold-skill.mdx";

const SKILLS_DIR = ".smithers/skills";

const DEFAULT_PROMPT =
  "Describe the pattern or run you want to harvest into a reusable skill, workflow, or memory.";

const inputSchema = z.object({
  // Named targetRunId (not runId): the engine reserves input.runId for the
  // run's own id, so a workflow that harvests ANOTHER run must use a
  // different field name.
  targetRunId: z
    .string()
    .nullable()
    .default(null)
    .describe("Run to harvest from. Null analyses the prompt/context alone, with no run state."),
  prompt: z
    .string()
    .default(DEFAULT_PROMPT)
    .describe("What to harvest, plus any context the analysis should ground itself in."),
});

// 1. Read the run/pattern and decide what is worth keeping.
const analyzeSchema = z.looseObject({
  repeatedPattern: z
    .string()
    .describe("One paragraph: the durable, repeatable pattern observed in the run/context."),
  reusableAsSkill: z
    .boolean()
    .describe("True when the pattern is best captured as an agent skill doc the workers can reuse."),
  reusableAsWorkflow: z
    .boolean()
    .describe("True when the pattern is better captured as a whole new Smithers workflow."),
  memoryFacts: z
    .array(z.string())
    .default([])
    .describe("Durable, run-independent facts worth remembering across future runs."),
});

// 2. Turn the analysis into concrete proposals.
const proposeSchema = z.looseObject({
  proposedSkill: z
    .object({
      name: z.string().describe("kebab-case skill id, used as the file name."),
      description: z.string().describe("One line: what it does and when to reach for it."),
      body: z.string().describe("Markdown body of the skill doc, ready to write to disk."),
    })
    .nullable()
    .default(null),
  proposedWorkflow: z
    .object({
      id: z.string().describe("kebab-case workflow id."),
      sketch: z.string().describe("A short prose sketch of the workflow graph and its stages."),
    })
    .nullable()
    .default(null),
  memoryToPersist: z
    .array(z.string())
    .default([])
    .describe("Final, polished memory facts to persist."),
});

// 3. The skill file actually written to disk when the pattern is reusable as a skill.
const scaffoldSkillSchema = z.looseObject({
  summary: z.string(),
  skillPath: z.string().nullable().default(null),
});

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  analyze: analyzeSchema,
  propose: proposeSchema,
  scaffoldSkill: scaffoldSkillSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied — coalesce
  // so the analyze prompt never sees an empty harvest section.
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;
  const analyze = ctx.outputMaybe("analyze", { nodeId: "analyze" });
  const propose = ctx.outputMaybe("propose", { nodeId: "propose" });

  // Only scaffold a skill file when the analysis says the pattern is skill-shaped
  // and the proposal actually produced a skill to write.
  const reusableAsSkill = analyze?.reusableAsSkill === true;
  const hasProposedSkill = propose?.proposedSkill != null;

  return (
    <Workflow name="extract-skill">
      <Sequence>
        {/* 1 — Read the run (if given) and decide what is worth harvesting. */}
        <Task
          id="analyze"
          output={outputs.analyze}
          agent={agents.smartTool}
          heartbeatTimeoutMs={600_000}
        >
          <AnalyzePrompt prompt={prompt} runId={ctx.input.targetRunId} skillsDir={SKILLS_DIR} />
        </Task>

        {/* 2 — Turn the analysis into a concrete skill/workflow proposal + memory. */}
        {analyze ? (
          <Task id="propose" output={outputs.propose} agent={agents.smart}>
            <ProposePrompt analysis={analyze} prompt={prompt} skillsDir={SKILLS_DIR} />
          </Task>
        ) : null}

        {/* 3 — If the pattern is reusable as a skill, write the skill file to disk. */}
        {propose ? (
          <Branch
            if={reusableAsSkill && hasProposedSkill}
            then={
              <Task
                id="scaffold-skill"
                output={outputs.scaffoldSkill}
                agent={agents.smartTool}
                heartbeatTimeoutMs={600_000}
              >
                <ScaffoldSkillPrompt skill={propose?.proposedSkill} skillsDir={SKILLS_DIR} />
              </Task>
            }
            else={null}
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});
