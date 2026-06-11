// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Create Skill
// smithers-description: Author a new agent skill (SKILL.md + supporting files) from a plain-English ask.
// smithers-tags: authoring, skills
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ClarifyPrompt from "../prompts/create-skill-clarify.mdx";
import DesignPrompt from "../prompts/create-skill-design.mdx";
import ScaffoldPrompt from "../prompts/create-skill-scaffold.mdx";
import DocumentPrompt from "../prompts/create-skill-document.mdx";

const SKILLS_DIR = ".smithers/skills";

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Describe the agent skill you want to create, in plain English.")
    .describe("Plain-English description of the agent skill you want Smithers to author."),
  name: z
    .string()
    .nullable()
    .default(null)
    .describe("Desired kebab-case skill id. Null lets the clarify/design steps choose one."),
  review: z
    .boolean()
    .default(true)
    .describe("Pause for human approval of the design before any files are written."),
});

// 1. The freeform ask, turned into a structured skill spec.
const skillSpecSchema = z.looseObject({
  name: z.string().describe("Proposed kebab-case skill id."),
  purpose: z.string().describe("One sentence: what the skill equips an agent to do."),
  whenToUse: z
    .string()
    .describe("Trigger phrasing — when an agent should reach for this skill."),
  capabilities: z
    .array(z.string())
    .default([])
    .describe("The concrete things an agent can do once this skill is in context."),
  inputs: z
    .array(z.object({ name: z.string(), type: z.string(), purpose: z.string() }))
    .default([])
    .describe("Parameters / context the skill expects when invoked."),
  openQuestions: z
    .array(z.string())
    .default([])
    .describe("Anything ambiguous the author should resolve."),
});

// 2. The concrete design the scaffolder turns into a real SKILL.md.
const designSchema = z.looseObject({
  skillName: z.string().describe("Final kebab-case skill id."),
  frontmatter: z
    .object({
      name: z.string(),
      description: z
        .string()
        .describe("One line: what it does and when to use it — goes in YAML frontmatter."),
    })
    .describe("YAML frontmatter for the SKILL.md file."),
  sections: z
    .array(z.object({ heading: z.string(), purpose: z.string() }))
    .default([])
    .describe("Ordered body sections the SKILL.md should contain."),
  supportingFiles: z
    .array(z.object({ path: z.string(), purpose: z.string() }))
    .default([])
    .describe("Optional extra files (scripts, references) the skill ships alongside SKILL.md."),
  rationale: z.string().default(""),
});

// Durable human approval decision (matches the Approval component's output shape).
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

// 3. Files written by the scaffold agent.
const scaffoldSchema = z.looseObject({
  summary: z.string(),
  skillName: z.string(),
  filesWritten: z
    .array(
      z.object({
        path: z.string(),
        kind: z.enum(["skill", "supporting", "other"]).default("skill"),
      }),
    )
    .default([]),
});

// 4. Agent-facing summary of what was created.
const documentSchema = z.looseObject({
  summary: z.string(),
  skillPath: z.string().nullable().default(null),
});

const { Workflow, Task, Sequence, Branch, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  clarify: skillSpecSchema,
  design: designSchema,
  approval: approvalSchema,
  scaffold: scaffoldSchema,
  document: documentSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied, and the
  // approval gate is documented as default-ON — coalesce so it actually is.
  const review = ctx.input.review ?? true;

  const clarify = ctx.outputMaybe("clarify", { nodeId: "clarify" });
  const design = ctx.outputMaybe("design", { nodeId: "design" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-design" });
  const scaffold = ctx.outputMaybe("scaffold", { nodeId: "scaffold" });

  const designed = design !== undefined;
  const approved = !review || approval?.approved === true;
  const proceed = designed && approved;

  // The name we scaffold against, resolved as soon as it is known.
  const skillName =
    scaffold?.skillName ?? design?.skillName ?? clarify?.name ?? ctx.input.name ?? "new-skill";

  return (
    <Workflow name="create-skill">
      <Sequence>
        {/* 1 — Turn the freeform ask into a structured skill spec. */}
        <Task id="clarify" output={outputs.clarify} agent={agents.smart}>
          <ClarifyPrompt
            request={ctx.input.prompt ?? "Describe the agent skill you want to create, in plain English."}
            name={ctx.input.name}
          />
        </Task>

        {/* 2 — Design the concrete SKILL.md from the spec. */}
        {clarify ? (
          <Task id="design" output={outputs.design} agent={agents.smart}>
            <DesignPrompt spec={clarify} skillsDir={SKILLS_DIR} />
          </Task>
        ) : null}

        {/* 3 — Optional durable human approval of the design before writing files. */}
        <Branch
          if={review && designed}
          then={
            <Approval
              id="approve-design"
              output={outputs.approval}
              request={{
                title: `Approve design for skill "${skillName}"`,
                summary:
                  design?.frontmatter?.description ??
                  "Review the proposed skill design before scaffolding.",
              }}
            />
          }
          else={null}
        />

        {/* 4 — Scaffold the real SKILL.md (and any supporting files). */}
        {proceed ? (
          <Task
            id="scaffold"
            output={outputs.scaffold}
            agent={agents.smartTool}
            heartbeatTimeoutMs={900_000}
          >
            <ScaffoldPrompt design={design} skillsDir={SKILLS_DIR} />
          </Task>
        ) : null}

        {/* 5 — Document what was created so the human knows how to use it. */}
        {proceed && scaffold ? (
          <Task id="document" output={outputs.document} agent={agents.cheapFast}>
            <DocumentPrompt skillName={skillName} design={design} scaffold={scaffold} />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
