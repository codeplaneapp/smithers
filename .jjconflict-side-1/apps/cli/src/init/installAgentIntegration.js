import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { wireExtraAgents } from "../agent-wiring/wireExtraAgents.js";
import { installCuratedSkill, skillTargets } from "../installCuratedSkill.js";

/** Claude Code marketplace coordinates for the smithers plugin. */
export const CLAUDE_PLUGIN_MARKETPLACE = "smithersai/smithers";
export const CLAUDE_PLUGIN_SPEC = "smithers@smithersai";

/**
 * @typedef {{ ok: boolean; output: string }} CommandResult
 * @typedef {(command: string, args: string[]) => CommandResult} CommandRunner
 * @typedef {{
 *   agent: string;
 *   kind: "plugin" | "skill" | "none";
 *   ok: boolean;
 *   detail: string;
 *   fallback?: boolean;
 * }} AgentIntegrationResult
 */

/**
 * Default command runner: synchronous, captured output, bounded so a hung
 * agent CLI can never wedge init.
 *
 * @type {CommandRunner}
 */
function runCommandSync(command, args) {
    try {
        const result = spawnSync(command, args, {
            encoding: "utf8",
            timeout: 120_000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
        return { ok: result.status === 0, output };
    }
    catch (err) {
        return { ok: false, output: err?.message ?? String(err) };
    }
}

/**
 * Install the richest Smithers integration the chosen agent supports:
 *
 * - Claude Code → the native marketplace plugin (slash commands, hooks,
 *   run-mirroring, MCP), with the curated skill as the fallback when the
 *   plugin install fails (offline, old CLI).
 * - Hermes / OpenClaw → their native plugin + MCP config (wireExtraAgents).
 * - Codex, Pi, OpenCode, Kimi, Amp, Antigravity → the curated `smithers`
 *   skill copied into that agent's skills directory.
 * - Anything else → nothing to install; reported as such.
 *
 * Best-effort by design: init must never fail because an integration step did.
 *
 * @param {{ agentId: string; env?: NodeJS.ProcessEnv; homeDir?: string; detections?: import("../AgentAvailability.ts").AgentAvailability[]; runCommand?: CommandRunner }} opts
 * @returns {AgentIntegrationResult}
 */
export function installAgentIntegration(opts) {
    const env = opts.env ?? process.env;
    const homeDir = opts.homeDir ?? env.HOME ?? homedir();
    const runCommand = opts.runCommand ?? runCommandSync;
    const agentId = opts.agentId;
    const detections = opts.detections;

    if (agentId === "claude") {
        const marketplace = runCommand("claude", ["plugin", "marketplace", "add", CLAUDE_PLUGIN_MARKETPLACE]);
        // An already-added marketplace makes `add` exit non-zero on some CLI
        // versions; the install step is the real gate, so always attempt it.
        const install = runCommand("claude", ["plugin", "install", CLAUDE_PLUGIN_SPEC]);
        if (install.ok) {
            return { agent: agentId, kind: "plugin", ok: true, detail: `Claude Code plugin ${CLAUDE_PLUGIN_SPEC}` };
        }
        const skill = installSkillFor(agentId, env, homeDir, detections);
        return {
            agent: agentId,
            kind: skill.ok ? "skill" : "none",
            ok: skill.ok,
            fallback: true,
            detail: skill.ok
                ? `plugin install failed (${firstLine(install.output || marketplace.output) || "unknown error"}); installed the smithers skill instead`
                : `plugin install failed and skill fallback failed: ${skill.detail}`,
        };
    }

    if (agentId === "hermes" || agentId === "openclaw") {
        try {
            const results = wireExtraAgents({ kind: "mcp", agents: [agentId], homeDir });
            const failed = results.find((entry) => entry.reason);
            return {
                agent: agentId,
                kind: "plugin",
                ok: !failed,
                detail: failed
                    ? `native plugin install incomplete: ${failed.reason}`
                    : `native ${agentId} plugin + MCP config`,
            };
        }
        catch (err) {
            return { agent: agentId, kind: "none", ok: false, detail: err?.message ?? String(err) };
        }
    }

    if (skillTargets(homeDir).some((target) => target.id === agentId)) {
        const skill = installSkillFor(agentId, env, homeDir, detections);
        return { agent: agentId, kind: skill.ok ? "skill" : "none", ok: skill.ok, detail: skill.detail };
    }

    return {
        agent: agentId,
        kind: "none",
        ok: true,
        detail: "no plugin or skills directory known for this agent",
    };
}

/**
 * @param {string} agentId
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homeDir
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} [detections]
 * @returns {{ ok: boolean; detail: string }}
 */
function installSkillFor(agentId, env, homeDir, detections) {
    const result = installCuratedSkill({ env, homeDir, detections, targets: [agentId] });
    const installed = result.installed[0];
    if (installed) return { ok: true, detail: `smithers skill → ${installed.path}` };
    const skipped = result.skipped[0];
    return { ok: false, detail: skipped ? `${skipped.agent}: ${skipped.reason}` : "skill install skipped" };
}

/** @param {string} text */
function firstLine(text) {
    return (text ?? "").split("\n")[0]?.trim() ?? "";
}
