// smithers-source: seeded
// smithers-display-name: Workflow Skill
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import WorkflowSkillPrompt from "../prompts/workflow-skill.mdx";

const WORKFLOW_ID = "workflow-skill";
const DEFAULT_SKILL_DIR = ".smithers/skills";

const inputSchema = z.object({
  workflow: z
    .string()
    .default("all")
    .describe('Workflow ID to document, or "all" for every local workflow.'),
  output: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional file path for one workflow, or directory path when workflow is all."),
  prompt: z
    .string()
    .default("")
    .describe("Optional extra instructions for the skill-writing agent."),
});

const workflowSourceSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  sourceType: z.string(),
  entryFile: z.string(),
  source: z.string(),
});

const existingSkillSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const collectSchema = z.object({
  workflowTarget: z.string(),
  output: z.string().nullable(),
  outputRule: z.string(),
  defaultSkillDir: z.string(),
  workflows: z.array(workflowSourceSchema),
  existingSkills: z.array(existingSkillSchema),
  prompt: z.string(),
});

const writeResultSchema = z.object({
  summary: z.string(),
  written: z
    .array(
      z.object({
        workflow: z.string(),
        path: z.string(),
        skillName: z.string(),
        action: z.enum(["created", "updated"]).default("updated"),
      }),
    )
    .default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  collect: collectSchema,
  writeResult: writeResultSchema,
});

function parseWorkflowMetadata(source: string, id: string) {
  const sourceMatch = source.match(/^\/\/\s*smithers-source:\s*(.+)$/m);
  const displayMatch = source.match(/^\/\/\s*smithers-display-name:\s*(.+)$/m);
  return {
    sourceType: sourceMatch?.[1]?.trim() || "user",
    displayName: displayMatch?.[1]?.trim() || id,
  };
}

function discoverWorkflowSources(root: string) {
  const dir = resolve(root, ".smithers/workflows");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => statSync(join(dir, file)).isFile())
    .sort()
    .map((file) => {
      const id = file.replace(/\.tsx$/, "");
      const entryFile = join(dir, file);
      const source = readFileSync(entryFile, "utf8");
      const metadata = parseWorkflowMetadata(source, id);
      return {
        id,
        displayName: metadata.displayName,
        sourceType: metadata.sourceType,
        entryFile,
        source,
      };
    });
}

function readExistingSkills(root: string) {
  const dir = resolve(root, DEFAULT_SKILL_DIR);
  if (!existsSync(dir)) return [];

  const out: Array<{ path: string; content: string }> = [];

  function walk(current: string, depth: number) {
    if (depth > 3) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push({
        path: full,
        content: readFileSync(full, "utf8"),
      });
    }
  }

  walk(dir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export default smithers((ctx) => {
  return (
    <Workflow name={WORKFLOW_ID}>
      <UI entry="../ui/workflow-skill.tsx" title={"Workflow Skill"} />
      <Task id="collect" output={outputs.collect}>
        {async () => {
          const root = process.cwd();
          // ctx.input fields arrive null (not their zod default) when unsupplied,
          // so coalesce before calling string methods or the collect step throws.
          const workflowTarget = (ctx.input.workflow ?? "all").trim() || "all";
          const output = ctx.input.output?.trim() || null;
          const allWorkflows = discoverWorkflowSources(root).filter(
            (workflow) => workflow.id !== WORKFLOW_ID,
          );
          const workflows =
            workflowTarget === "all"
              ? allWorkflows
              : allWorkflows.filter((workflow) => workflow.id === workflowTarget);

          if (workflows.length === 0) {
            throw new Error(`Workflow not found: ${workflowTarget}`);
          }
          if (workflowTarget === "all" && output?.endsWith(".md")) {
            throw new Error(
              "When workflow is all, output must be a directory path, not a .md file.",
            );
          }

          return {
            workflowTarget,
            output,
            outputRule:
              workflowTarget === "all"
                ? output
                  ? `Write one skill per workflow under ${output}.`
                  : `Write one skill per workflow under ${DEFAULT_SKILL_DIR}.`
                : output
                  ? `Write the skill to exactly ${output}.`
                  : `Write the skill under ${DEFAULT_SKILL_DIR}/<agent-chosen-name>.md.`,
            defaultSkillDir: DEFAULT_SKILL_DIR,
            workflows,
            existingSkills: readExistingSkills(root),
            prompt: ctx.input.prompt,
          };
        }}
      </Task>

      <Task
        id="write-skills"
        output={outputs.writeResult}
        agent={agents.smartTool}
        heartbeatTimeoutMs={600_000}
        deps={{ collect: outputs.collect }}
      >
        {(deps) => (
          <WorkflowSkillPrompt
            workflowTarget={deps.collect.workflowTarget}
            output={deps.collect.output}
            outputRule={deps.collect.outputRule}
            defaultSkillDir={deps.collect.defaultSkillDir}
            workflows={deps.collect.workflows}
            existingSkills={deps.collect.existingSkills}
            prompt={deps.collect.prompt}
          />
        )}
      </Task>
    </Workflow>
  );
});
