// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Upgrade (system)
// smithers-description: Agent-assisted Smithers upgrade: fetch changelogs since the installed version, let a cheap agent run the upgrade, and escalate to a smart agent only when needed.
// smithers-tags: system, upgrade, ops
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

// Input is intentionally loose and fieldless so `smithers upgrade` can pass
// machine options without the interactive TUI prompting for them.
const inputSchema = z.looseObject({});

const changelogEntrySchema = z.object({
  version: z.string(),
  url: z.string(),
  ok: z.boolean(),
  content: z.string(),
  error: z.string().optional(),
});

const gatherSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  installKind: z.string(),
  installManager: z.string(),
  command: z.string().nullable(),
  runnable: z.boolean(),
  explanation: z.string(),
  dryRun: z.boolean(),
  changelogVersions: z.array(z.string()),
  changelogFetchTruncated: z.boolean(),
  changelogs: z.array(changelogEntrySchema),
  summary: z.string(),
});

const attemptSchema = z.looseObject({
  success: z.boolean().default(false),
  needsHelp: z.string().default(""),
  summary: z.string().default(""),
  commands: z.array(z.string()).default([]),
  details: z.string().default(""),
  versionAfter: z.string().default(""),
});

const outputSchema = z.object({
  success: z.boolean(),
  needsHelp: z.string(),
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  command: z.string().nullable(),
  changelogVersions: z.array(z.string()),
  summary: z.string(),
  commands: z.array(z.string()),
  details: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  cheapUpgrade: attemptSchema,
  smartUpgrade: attemptSchema,
  output: outputSchema,
});

const cliModule = (name: string) =>
  process.env.SMITHERS_CLI_SRC_DIR
    ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js`
    : `@smithers-orchestrator/cli/${name}`;

function boolInput(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

// Single source of truth for "does this attempt have a blocker": trims
// whitespace-only needsHelp to blank so it never masquerades as a real
// blocker, and is reused for both the escalation decision and the final
// output so the two can never disagree (they used to: escalation trimmed,
// the final success check did not, so a whitespace-only needsHelp flipped a
// successful attempt to success=false in the terminal output).
function normalizedBlocker(attempt: { needsHelp?: unknown } | undefined): string {
  return typeof attempt?.needsHelp === "string" ? attempt.needsHelp.trim() : "";
}

export default smithers((ctx) => {
  const rawInput = ctx.input as Record<string, unknown>;
  const dryRun = boolInput(rawInput.dryRun);
  const gather = ctx.outputMaybe("gather", { nodeId: "gather" });
  const cheap = ctx.outputMaybe("cheapUpgrade", { nodeId: "cheap-upgrade" });
  const smart = ctx.outputMaybe("smartUpgrade", { nodeId: "smart-upgrade" });
  // Escalate when the cheap attempt failed outright OR left a real (non-blank)
  // blocker — success=false with an empty needsHelp is still a failure to
  // escalate on, not a silent stop.
  const needsSmart = Boolean(cheap) && (cheap!.success === false || normalizedBlocker(cheap).length > 0);
  const finalAttempt = needsSmart ? smart : cheap;
  const finalBlocker = normalizedBlocker(finalAttempt);

  return (
    <Workflow name="upgrade">
      <Sequence>
        <Task id="gather" output={outputs.gather} retries={0}>
          {async () => {
            const {
              SMITHERS_PACKAGE,
              buildUpdatePlan,
              detectInstallMethod,
              fetchChangelogsSince,
              fetchLatestVersion,
              isUpdateAvailable,
              readCurrentPackageVersion,
            } = await import(cliModule("update-check"));

            const current = readCurrentPackageVersion();
            const latest = await fetchLatestVersion({ timeoutMs: 8000 });
            const install = detectInstallMethod();
            const plan = buildUpdatePlan(install, SMITHERS_PACKAGE);
            const updateAvailable =
              typeof latest === "string" && latest.length > 0 ? isUpdateAvailable(latest, current) : false;
            const changelogs = await fetchChangelogsSince({
              currentVersion: current,
              latestVersion: latest,
              timeoutMs: 8000,
              maxEntries: 20,
              maxCharsPerEntry: 12_000,
            });

            return {
              current,
              latest,
              updateAvailable,
              installKind: install.kind,
              installManager: install.manager,
              command: plan.command,
              runnable: plan.runnable,
              explanation: plan.explanation,
              dryRun,
              changelogVersions: changelogs.versions,
              changelogFetchTruncated: changelogs.truncated,
              changelogs: changelogs.entries,
              summary: updateAvailable
                ? `Smithers ${latest} is available (installed ${current}); fetched ${changelogs.entries.length} changelog(s).`
                : `Smithers is up to date or the latest version could not be confirmed (installed ${current}).`,
            };
          }}
        </Task>

        {gather ? (
          <Task id="cheap-upgrade" output={outputs.cheapUpgrade} agent={agents.cheapFast} timeoutMs={20 * 60_000}>
            {`You are the cheap Smithers upgrade driver. Your job is to upgrade the installed Smithers CLI/plugin safely, using the deterministic evidence below.

Rules:
- If updateAvailable is false, do not mutate anything. Return success=true with a concise summary.
- If dryRun is true, do not mutate anything. Return success=true and list the command you would run.
- If a runnable command is provided, run that exact command first.
- After running an upgrade command, verify with \`smithers --version\` when available, or \`bunx smithers-orchestrator --version\` as a fallback.
- Do not edit repository source files, workflow files, or user configuration. This workflow upgrades the installed CLI/package/plugin only.
- If the install plan is not runnable, a command fails, credentials/permissions are missing, the package manager asks an interactive question, or you are unsure, STOP and return needsHelp with a specific reason. Do not guess.
- Do not try to delegate yourself. Returning needsHelp triggers the smart-agent escalation step.

Evidence:
${JSON.stringify(gather, null, 2)}

Return:
- success: true only when no update was needed, dry-run planning completed, or the upgrade was verified.
- needsHelp: "" on success, otherwise a specific one-sentence reason for smart escalation.
- summary: short operator-facing result.
- commands: commands you ran or would run.
- details: important output or why you stopped.
- versionAfter: verified version string when available.`}
          </Task>
        ) : null}

        {gather && needsSmart ? (
          <Task id="smart-upgrade" output={outputs.smartUpgrade} agent={agents.implement} timeoutMs={45 * 60_000}>
            {`The cheap Smithers upgrade driver stopped and requested help:
${cheap?.needsHelp}

Take over the upgrade using the evidence below. You may run shell commands, but keep the same safety rules:
- Do not edit repository source files, workflow files, or user configuration unless that is the only correct way to repair a project-local install, and then explain exactly what changed.
- Prefer the deterministic upgrade command when it is valid.
- Verify the resulting Smithers version.
- If the situation still needs a human, return needsHelp with the specific blocker.

Gathered upgrade context:
${JSON.stringify(gather, null, 2)}

Cheap attempt:
${JSON.stringify(cheap, null, 2)}

Return the same shape: success, needsHelp, summary, commands, details, versionAfter.`}
          </Task>
        ) : null}

        {gather && finalAttempt ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              success: finalAttempt.success === true && finalBlocker.length === 0,
              needsHelp: finalBlocker,
              current: gather.current,
              latest: gather.latest,
              updateAvailable: gather.updateAvailable,
              command: gather.command,
              changelogVersions: gather.changelogVersions,
              summary: finalAttempt.summary || gather.summary,
              commands: Array.isArray(finalAttempt.commands) ? finalAttempt.commands : [],
              details: String(finalAttempt.details ?? ""),
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
