import { basename, resolve } from "node:path";
import { intro, isCancel, log, multiselect } from "@clack/prompts";
import pc from "picocolors";
import { accountsRoot } from "@smthrs/accounts";
import { detectAvailableAgents } from "./agent-detection.js";
import { applyWorkflowPackUpdates, CURATED_PUBLIC_WORKFLOW_IDS, initWorkflowPack } from "./workflow-pack.js";
import { buildDefaultSelections, selectionsToPackOptions } from "./init/interactiveInit.js";
import { installAgentIntegration } from "./init/installAgentIntegration.js";
import { selectPreferredAgent } from "./init/selectPreferredAgent.js";

/**
 * Render the human-facing `smithers init` flow: one question (which coding
 * agent do you prefer?), then a clack ceremony that narrates the scaffold →
 * integration install steps. Workflows and skills install with defaults —
 * the agent choice is the only selection init asks for.
 *
 * Returns the {@link InitResult} of the underlying {@link initWorkflowPack}
 * call, extended with `preferredAgent`, `integration`, `detections`, and
 * `selectedWorkflowCount` so structured output can report the curated pack.
 *
 * Only call this in interactive TTY mode; piped/agent callers should use
 * {@link initWorkflowPack} directly so structured output is preserved.
 *
 * @param {{ force?: boolean; agentsOnly?: boolean; install?: boolean; global?: boolean; installSkill?: boolean; updatePrompt?: boolean; agent?: string; env?: NodeJS.ProcessEnv; detections?: import("./AgentAvailability.ts").AgentAvailability[]; selectAgent?: typeof selectPreferredAgent; installIntegration?: typeof installAgentIntegration }} opts
 * @returns {Promise<import("./workflow-pack.js").InitResult>}
 */
export async function runInitCeremony(opts = {}) {
  const env = opts.env ?? process.env;
  const agentsOnly = Boolean(opts.agentsOnly);
  const global = Boolean(opts.global);
  const installSkill = opts.installSkill !== false;
  // Injectable so CI tests can exercise cancel/no-agent paths without a PTY.
  const selectAgent = opts.selectAgent ?? selectPreferredAgent;
  const installIntegration = opts.installIntegration ?? installAgentIntegration;

  const packRoot = global ? accountsRoot(env) : resolve(process.cwd(), ".smithers");
  const selections = buildDefaultSelections(env, packRoot);

  intro(`${pc.bgCyan(pc.black(" smithers "))} ${pc.dim(global ? "init --global" : "init")}`);

  const detections = (opts.detections ?? detectAvailableAgents(env)).filter((agent) => !agent.deprecated);
  renderAgents(detections);

  // ------------------------------------------------------------------
  // Step 1: the ONE selection — which agent does the user prefer?
  // ------------------------------------------------------------------
  // Skipped for --agents-only (no integrations or tutorial there).
  let preferred = null;
  if (!agentsOnly) {
    const choice = await selectAgent({ env, preselect: opts.agent, detections });
    if (choice === "cancelled") {
      process.stderr.write(`${pc.yellow("✗")} init cancelled — nothing was installed\n`);
      process.exit(130);
    }
    if (choice === null) {
      log.warn(
        [
          "No usable coding agent detected — installing the pack with defaults.",
          pc.dim(
            "Install codex (`npm i -g @openai/codex` + `codex login`) or Claude Code (`claude` + `/login`), then re-run `smithers init`.",
          ),
        ].join("\n"),
      );
    } else {
      preferred = choice.detection;
      const how = choice.source === "flag" ? " (from --agent)" : choice.source === "auto" ? " (only usable agent)" : "";
      log.success(`Preferred agent: ${pc.cyan(preferred.displayName)}${pc.dim(how)}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 2: install the workflow pack with defaults, narrated
  // ------------------------------------------------------------------
  const reporter = {
    scaffolded({ writtenCount, skippedCount }) {
      const base = global ? "~/.smithers/" : ".smithers/";
      const target = pc.cyan(agentsOnly ? `${base}agents/` : base);
      log.success(`Scaffolded ${agentsOnly ? "agent config" : "workflow pack"} into ${target}`);
      const parts = [];
      if (writtenCount > 0)
        parts.push(`${pc.bold(String(writtenCount))} ${pc.dim(`file${writtenCount === 1 ? "" : "s"} created`)}`);
      if (skippedCount > 0) parts.push(`${pc.bold(String(skippedCount))} ${pc.dim("preserved")}`);
      log.message(parts.length > 0 ? parts.join(pc.dim("  ·  ")) : pc.dim("nothing to write (pack already present)"));
      if (!agentsOnly) {
        const wfCount = CURATED_PUBLIC_WORKFLOW_IDS.length;
        log.message(`${pc.dim("→")} Installing ${pc.bold(String(wfCount))} workflow${wfCount === 1 ? "" : "s"}`);
      }
    },
    skillInstalled(result) {
      if (result.installed.length === 0) return;
      const agents = result.installed.map((entry) => entry.agent).join(", ");
      log.message(`${pc.dim("→")} Installed the ${pc.cyan(result.skill)} skill for you ${pc.dim("(" + agents + ")")}`);
      // These land outside the project. `init` reads as project-local, so name
      // the machine-wide paths rather than leaving them to be discovered
      // later (#1464 AWF-8).
      const home = env.HOME ?? "";
      const paths = result.installed
        .map((entry) => (home && entry.path.startsWith(home) ? `~${entry.path.slice(home.length)}` : entry.path))
        .join(", ");
      log.message(`${pc.dim("  outside this project, in")} ${pc.dim(paths)} ${pc.dim("(--no-skill to skip)")}`);
    },
    agentDocsNoted(result) {
      const updated = result.files.filter((file) => file.status === "updated");
      if (updated.length === 0) return;
      const names = updated.map((file) => pc.cyan(basename(file.path))).join(", ");
      log.message(`${pc.dim("→")} Added ${pc.cyan("smithers.sh")} workflow guidance to ${names}`);
    },
    gitignoreEnsured(result) {
      if (result.status !== "created" && result.status !== "updated") return;
      log.message(`${pc.dim("→")} Ignored the ${pc.cyan("smithers.db")} run store in ${pc.cyan(".gitignore")}`);
    },
    installStart() {
      log.step("Installing dependencies " + pc.dim("(bun install)"));
    },
    installDone(result, captured) {
      if (result.status === "ok") {
        log.success("Dependencies installed");
        return;
      }
      log.warn(`Skipping install: ${result.reason}`);
      const tail = (captured?.stderr || captured?.stdout || "").trim().split("\n").slice(-4).join("\n");
      if (tail) log.message(pc.dim(tail));
    },
  };

  const selectedOptions = selectionsToPackOptions(selections);
  const result = initWorkflowPack({
    force: opts.force,
    agentsOnly,
    global,
    installSkill,
    skipInstall: agentsOnly || opts.install === false,
    selectedSkillTargets: agentsOnly ? undefined : selectedOptions.selectedSkillTargets,
    selectedAgentDocs: agentsOnly ? undefined : selectedOptions.selectedAgentDocs,
    reporter,
  });

  // ------------------------------------------------------------------
  // Step 3: best-tier integration (plugin, or skill if no plugin) for the
  // preferred agent
  // ------------------------------------------------------------------
  if (preferred) {
    log.step(`Configuring ${preferred.displayName} ${pc.dim("(plugin, or skill if no plugin)")}`);
    const integration = installIntegration({ agentId: preferred.id, env, detections });
    if (integration.kind === "plugin" && integration.ok) {
      log.success(
        `Installed the smithers plugin for ${pc.cyan(preferred.displayName)} ${pc.dim("(" + integration.detail + ")")}`,
      );
    } else if (integration.kind === "skill" && integration.ok) {
      const note = integration.fallback ? " (no plugin available here)" : "";
      log.success(`Installed the smithers skill for ${pc.cyan(preferred.displayName)}${pc.dim(note)}`);
    } else {
      log.warn(`Could not configure ${preferred.displayName}: ${integration.detail}`);
    }
    result.integration = integration;
  }
  result.preferredAgent = preferred;
  result.detections = detections;
  result.selectedWorkflowCount = agentsOnly ? 0 : CURATED_PUBLIC_WORKFLOW_IDS.length;

  // Offer to update any shipped pack files that drifted from the latest
  // bundled version (a default run preserves existing files). Skipped with
  // --no-update-prompt and whenever nothing drifted.
  if (opts.updatePrompt !== false && result.changedFiles && result.changedFiles.length > 0) {
    result.updatedFiles = await promptPackUpdates(result.changedFiles);
  }

  return result;
}

const relPack = (path) => path.replace(/^\.smithers\//, "");

/**
 * Interactive multi-select over pack files that differ from the latest
 * bundled version, then writes the chosen files.
 *
 * @param {Array<{ path: string; absolutePath: string; contents: string }>} changedFiles
 * @returns {Promise<string[]>} absolute paths written
 */
async function promptPackUpdates(changedFiles) {
  const count = changedFiles.length;
  log.warn(`${pc.bold(String(count))} pack file${count === 1 ? "" : "s"} differ from the latest bundled version.`);

  const selected = await multiselect({
    message: "Update which pack files? " + pc.dim("(the latest version overwrites your local copy)"),
    options: changedFiles.map((file) => ({
      value: file.path,
      label: relPack(file.path),
    })),
    required: false,
  });

  if (isCancel(selected)) {
    log.message(pc.dim("Update prompt cancelled — pack files left as-is."));
    return [];
  }
  if (!Array.isArray(selected) || selected.length === 0) {
    log.message(pc.dim("No pack files selected — left as-is."));
    return [];
  }

  const chosen = changedFiles.filter((file) => selected.includes(file.path));
  const written = applyWorkflowPackUpdates(chosen);
  log.success(`Updated ${pc.bold(String(written.length))} pack file${written.length === 1 ? "" : "s"}`);

  return written;
}

/**
 * Show which coding agents Smithers found on this machine, so it's obvious
 * what the agent picker offers and what's missing.
 *
 * @param {import("./AgentAvailability.ts").AgentAvailability[]} detections Non-deprecated detections.
 */
function renderAgents(detections) {
  if (detections.length === 0) return;
  const usable = detections.filter((agent) => agent.usable);
  const lines = detections
    .slice()
    .sort((left, right) => Number(right.usable) - Number(left.usable))
    .map((agent) =>
      agent.usable
        ? `${pc.green("✓")} ${agent.displayName}`
        : `${pc.dim("○")} ${pc.dim(agent.displayName)} ${pc.dim(`(${agent.unusableReasons[0] ?? "unavailable"})`)}`,
    );
  log.step(`Coding agents ${pc.dim(`(${usable.length} ready)`)}`);
  log.message(lines.join("\n"));
}
