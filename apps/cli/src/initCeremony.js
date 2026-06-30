import { basename } from "node:path";
import { intro, isCancel, log, multiselect } from "@clack/prompts";
import pc from "picocolors";
import { detectAvailableAgents } from "./agent-detection.js";
import { applyWorkflowPackUpdates, initWorkflowPack } from "./workflow-pack.js";

/**
 * Render the human-facing `smithers init` flow: a clean clack ceremony that
 * narrates each step (scaffold → detect agents → install) instead of dumping
 * the raw result object. Returns the same {@link InitResult} as a plain
 * {@link initWorkflowPack} call so callers can attach templates/CTAs after.
 *
 * Only call this in interactive TTY mode; piped/agent callers should use
 * {@link initWorkflowPack} directly so structured output is preserved.
 *
 * @param {{ force?: boolean; agentsOnly?: boolean; install?: boolean; global?: boolean; installSkill?: boolean; updatePrompt?: boolean; env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<import("./workflow-pack.js").InitResult>}
 */
export async function runInitCeremony(opts = {}) {
    const env = opts.env ?? process.env;
    const agentsOnly = Boolean(opts.agentsOnly);
    const global = Boolean(opts.global);
    const installSkill = opts.installSkill !== false;

    intro(`${pc.bgCyan(pc.black(" smithers "))} ${pc.dim(global ? "init --global" : "init")}`);

    const reporter = {
        scaffolded({ writtenCount, skippedCount }) {
            const base = global ? "~/.smithers/" : ".smithers/";
            const target = pc.cyan(agentsOnly ? `${base}agents/` : base);
            log.success(`Scaffolded ${agentsOnly ? "agent config" : "workflow pack"} into ${target}`);
            const parts = [];
            if (writtenCount > 0) parts.push(`${pc.bold(String(writtenCount))} ${pc.dim(`file${writtenCount === 1 ? "" : "s"} created`)}`);
            if (skippedCount > 0) parts.push(`${pc.bold(String(skippedCount))} ${pc.dim("preserved")}`);
            log.message(parts.length > 0 ? parts.join(pc.dim("  ·  ")) : pc.dim("nothing to write (pack already present)"));
            renderAgents(env);
        },
        skillInstalled(result) {
            if (result.installed.length === 0) return;
            const agents = result.installed.map((entry) => entry.agent).join(", ");
            log.message(`${pc.dim("→")} Installed the ${pc.cyan(result.skill)} skill for you ${pc.dim("(" + agents + ")")}`);
        },
        agentDocsNoted(result) {
            const updated = result.files.filter((file) => file.status === "updated");
            if (updated.length === 0) return;
            const names = updated.map((file) => pc.cyan(basename(file.path))).join(", ");
            log.message(`${pc.dim("→")} Added ${pc.cyan("smithers.sh")} workflow guidance to ${names}`);
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

    const result = initWorkflowPack({
        force: opts.force,
        agentsOnly,
        global,
        installSkill,
        skipInstall: agentsOnly || opts.install === false,
        reporter,
    });

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
 * Interactive multi-select over the pack files that differ from the latest
 * bundled version. Warns when a selected file is a shared component (other
 * workflows are built on it), then writes the chosen files.
 *
 * @param {Array<{ path: string; absolutePath: string; contents: string; isComponent: boolean; importedBy: string[] }>} changedFiles
 * @returns {Promise<string[]>} absolute paths written
 */
async function promptPackUpdates(changedFiles) {
    const count = changedFiles.length;
    log.warn(`${pc.bold(String(count))} pack file${count === 1 ? "" : "s"} differ from the latest bundled version.`);

    const sharedChanged = changedFiles.filter((file) => file.isComponent && file.importedBy.length > 0);
    if (sharedChanged.length > 0) {
        log.message(`${pc.yellow("Shared components")} ${pc.dim("— updating one re-affects every workflow that imports it:")}`);
        for (const file of sharedChanged) {
            log.message(`  ${pc.yellow(relPack(file.path))} ${pc.dim("→ " + file.importedBy.join(", "))}`);
        }
    }

    const selected = await multiselect({
        message: "Update which pack files? " + pc.dim("(the latest version overwrites your local copy)"),
        options: changedFiles.map((file) => ({
            value: file.path,
            label: relPack(file.path),
            hint: file.isComponent && file.importedBy.length > 0
                ? `shared · affects ${file.importedBy.length} workflow${file.importedBy.length === 1 ? "" : "s"}`
                : undefined,
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

    const chosenShared = chosen.filter((file) => file.isComponent && file.importedBy.length > 0);
    if (chosenShared.length > 0) {
        log.warn("You updated shared component(s) — re-check the workflows built on them:");
        for (const file of chosenShared) {
            log.message(`  ${pc.yellow(relPack(file.path))} ${pc.dim("→ " + file.importedBy.join(", "))}`);
        }
    }
    return written;
}

/**
 * Show which coding agents Smithers found on this machine, so it's obvious what
 * `agents.ts` was wired up to and what's missing.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function renderAgents(env) {
    const detections = detectAvailableAgents(env).filter((agent) => !agent.deprecated);
    if (detections.length === 0) return;
    const usable = detections.filter((agent) => agent.usable);
    const lines = detections
        .slice()
        .sort((left, right) => Number(right.usable) - Number(left.usable))
        .map((agent) => agent.usable
            ? `${pc.green("✓")} ${agent.displayName}`
            : `${pc.dim("○")} ${pc.dim(agent.displayName)} ${pc.dim(`(${agent.unusableReasons[0] ?? "unavailable"})`)}`);
    log.step(`Coding agents ${pc.dim(`(${usable.length} ready)`)}`);
    log.message(lines.join("\n"));
}
