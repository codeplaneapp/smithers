// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Init (system)
// smithers-description: Durable `smithers init`: install or refresh the .smithers workflow pack and the curated agent skills as replayable workflow steps.
// smithers-tags: system, init
// smithers-system: true
// smithers-disable-model-invocation: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { resolve } from "node:path";
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

const agentDocsSchema = z.object({
  noted: z.boolean().describe("Whether workflow guidance was appended to an agent doc."),
  detail: z.string().describe("Human-readable summary of the agent-doc update."),
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
  agentDocs: agentDocsSchema,
  output: outputSchema,
});

// The CLI's own module directory when this workflow runs through the smithers
// CLI (`smithers init` / `workflow run`), so the import below always resolves
// the exact code that launched the run; the package specifier is the fallback
// for runs the CLI did not launch. A computed specifier keeps `tsc` from
// failing the pack typecheck (the CLI ships no type declarations to packs).
const cliModule = (name: string) =>
  process.env.SMITHERS_CLI_SRC_DIR
    ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js`
    : `@smithers-orchestrator/cli/${name}`;

export default smithers((ctx) => {
  const force = ctx.input.force ?? false;
  const refreshSkills = ctx.input.refreshSkills ?? true;
  const skipInstall = ctx.input.skipInstall ?? false;
  const pack = ctx.outputMaybe("pack", { nodeId: "install-pack" });
  const skills = ctx.outputMaybe("skills", { nodeId: "refresh-skills" });
  return (
    <Workflow name="init">
      <Sequence>
        {/* retries=0: a deterministic scaffold either works or it never will
            (e.g. unresolvable import) — the engine's default infinite compute
            retries would hang the CLI instead of letting it fall back to the
            imperative path. */}
        <Task id="install-pack" output={outputs.pack} retries={0}>
          {async () => {
            const { initWorkflowPack } = await import(cliModule("workflow-pack"));
            const result = initWorkflowPack({ force, skipInstall });
            return {
              written: result.writtenFiles.length,
              skipped: result.skippedFiles.length,
              changed: (result.changedFiles ?? []).map((file: { path: string }) => file.path),
            };
          }}
        </Task>
        {pack ? (
          <Task id="refresh-skills" output={outputs.skills} retries={0}>
            {async () => {
              if (!refreshSkills) {
                return { refreshed: false, detail: "skipped (refreshSkills=false)" };
              }
              // The imperative path routes skill refresh through
              // ensureCuratedSkillsFresh, which honors this opt-out; the durable
              // path calls refreshCuratedSkills directly, so re-check it here.
              if (process.env.SMITHERS_NO_SKILL_REFRESH === "1") {
                return { refreshed: false, detail: "skipped (SMITHERS_NO_SKILL_REFRESH=1)" };
              }
              const { refreshCuratedSkills, formatRefreshNotice } = await import(
                cliModule("refreshCuratedSkills")
              );
              const result = refreshCuratedSkills({});
              return { refreshed: true, detail: formatRefreshNotice(result) || "up to date" };
            }}
          </Task>
        ) : null}
        {pack ? (
          <Task id="note-agent-docs" output={outputs.agentDocs} retries={0}>
            {async () => {
              // Mirror the imperative path: append the smithers.sh workflow
              // guidance block to any existing CLAUDE.md / AGENTS.md. Gated on
              // refreshSkills so a single `--no-skill` opts out of every
              // agent-instruction mutation, matching the CLI.
              if (!refreshSkills) {
                return { noted: false, detail: "skipped (refreshSkills=false)" };
              }
              const [{ noteWorkflowPreferenceInAgentDocs }, { resolveEffectiveAgentDocs }] =
                await Promise.all([
                  import(cliModule("noteWorkflowPreferenceInAgentDocs")),
                  import(cliModule("workflow-pack")),
                ]);
              // Honor a persisted à-la-carte deselection (pack-selections.json):
              // an interactive init that unchecked CLAUDE.md/AGENTS.md must not be
              // re-added by this non-interactive durable re-init. undefined =
              // nothing deselected = both docs (the helper's default).
              const fileNames = resolveEffectiveAgentDocs(resolve(process.cwd(), ".smithers"));
              const result = noteWorkflowPreferenceInAgentDocs({
                projectRoot: process.cwd(),
                ...(fileNames ? { fileNames } : {}),
              });
              const updated = result.files.filter((file: { status: string }) => file.status === "updated").length;
              return {
                noted: updated > 0,
                detail: updated > 0 ? `appended guidance to ${updated} agent doc(s)` : "no agent docs to update",
              };
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
