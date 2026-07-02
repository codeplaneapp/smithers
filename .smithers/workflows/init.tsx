// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Init (system)
// smithers-description: Durable `smithers init`: install or refresh the .smithers workflow pack and the curated agent skills as replayable workflow steps.
// smithers-tags: system, init
// smithers-system: true
// smithers-disable-model-invocation: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

// The durable form of `smithers init`. Every step is a deterministic task that
// calls the same functions the imperative CLI path uses, so a crash mid-init
// resumes instead of leaving a half-written pack, and every file the pack
// touched is recorded in the run. Marked `system: true`: internal plumbing,
// hidden from default workflow listings but runnable explicitly
// (`smithers workflow run init`) and re-runnable to refresh the pack.

const inputSchema = z.object({
  force: z
    .boolean()
    .default(false)
    .describe("Overwrite existing (non-preserved) pack files with the bundled templates."),
  refreshSkills: z
    .boolean()
    .default(true)
    .describe("Also refresh the curated `smithers` skill for every detected agent."),
  skipInstall: z
    .boolean()
    .default(false)
    .describe("Skip `bun install` inside .smithers/ after scaffolding."),
});

const packSchema = z.object({
  written: z.number().int().describe("Pack files written."),
  skipped: z.number().int().describe("Existing files left untouched."),
  changed: z
    .array(z.string())
    .describe("Existing files that drifted from the bundled templates (re-run with --force to update)."),
});

const skillsSchema = z.object({
  refreshed: z.boolean().describe("Whether the curated skills were refreshed."),
  detail: z.string().describe("Human-readable refresh summary."),
});

const outputSchema = z.object({
  written: z.number().int(),
  skipped: z.number().int(),
  changed: z.array(z.string()),
  skills: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  pack: packSchema,
  skills: skillsSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const force = ctx.input.force ?? false;
  const refreshSkills = ctx.input.refreshSkills ?? true;
  const skipInstall = ctx.input.skipInstall ?? false;
  const pack = ctx.outputMaybe("pack", { nodeId: "install-pack" });
  const skills = ctx.outputMaybe("skills", { nodeId: "refresh-skills" });
  return (
    <Workflow name="init">
      <Sequence>
        <Task id="install-pack" output={outputs.pack}>
          {async () => {
            const { initWorkflowPack } = await import("@smithers-orchestrator/cli/workflow-pack");
            const result = initWorkflowPack({ force, skipInstall });
            return {
              written: result.writtenFiles.length,
              skipped: result.skippedFiles.length,
              changed: (result.changedFiles ?? []).map((file: { path: string }) => file.path),
            };
          }}
        </Task>
        {pack ? (
          <Task id="refresh-skills" output={outputs.skills}>
            {async () => {
              if (!refreshSkills) {
                return { refreshed: false, detail: "skipped (refreshSkills=false)" };
              }
              const { refreshCuratedSkills, formatRefreshNotice } = await import(
                "@smithers-orchestrator/cli/refreshCuratedSkills"
              );
              const result = refreshCuratedSkills({});
              return { refreshed: true, detail: formatRefreshNotice(result) || "up to date" };
            }}
          </Task>
        ) : null}
        {pack && skills ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              written: pack.written,
              skipped: pack.skipped,
              changed: pack.changed,
              skills: skills.detail,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
