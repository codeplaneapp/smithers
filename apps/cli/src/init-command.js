import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "incur";
import { SmithersError } from "@smithers-orchestrator/errors";
import { agentAddWizard } from "./agent-commands/agentAddWizard.js";
import { runInitCeremony } from "./initCeremony.js";
import { renderInitNextSteps } from "./renderInitNextSteps.js";
import { STARTER_TEMPLATE_IDS, buildStarterGallery, findStarterRecipe } from "./starter-gallery.js";
import { initWorkflowPack } from "./workflow-pack.js";
import { isCI, isAgentHarness } from "./util/envDetect.js";

const initTemplateOption = z
    .union(STARTER_TEMPLATE_IDS.map((id) => z.literal(id)))
    .optional()
    .describe("Show next steps for a canonical starter template ID after init");

/**
 * Optional positional args for `smithers init`.
 * When `prompt` is provided, the pack is installed (if needed) and then the
 * create-workflow builder is launched with the prompt pre-filled.
 */
export const initArgs = z.object({
    prompt: z
        .string()
        .optional()
        .describe("Optional plain-English task: after init, launch the create-workflow builder with this prompt pre-filled"),
});

export const initOptions = z.object({
    force: z.boolean().default(false).describe("Overwrite existing scaffold files"),
    agentsOnly: z.boolean().default(false).describe("Only create .smithers/agents/ and leave the rest of the workflow pack untouched"),
    install: z.boolean().default(true).describe("Run `bun install` inside .smithers/ after scaffolding (--no-install to skip)"),
    addAgents: z.boolean().default(false).describe("After scaffolding, launch the interactive `agents add` wizard to register one or more accounts."),
    skill: z.boolean().default(true).describe("Install the curated `smithers` skill into your detected coding agents (Claude Code, Pi) and, if a CLAUDE.md or AGENTS.md exists, append guidance on when to use smithers.sh workflows. Use --no-skill to skip."),
    global: z.boolean().default(false).describe("Scaffold the global pack in ~/.smithers (honors SMITHERS_HOME) instead of ./.smithers. Global workflows run from any repo; a repo's local pack takes precedence."),
    updatePrompt: z.boolean().default(true).describe("In an interactive terminal, when shipped pack files differ from the latest bundled version, ask which to update (warning when a shared component is selected). Use --no-update-prompt to skip the question."),
    template: initTemplateOption,
    yes: z.boolean().default(false).describe("Non-interactive: skip prompts and use defaults (safe for agents and CI). Alias: --non-interactive."),
    nonInteractive: z.boolean().default(false).describe("Non-interactive: skip prompts and use defaults (safe for agents and CI). Alias: --yes."),
});

/**
 * Resolve whether this invocation should run interactively (clack ceremony)
 * or non-interactively (structured initWorkflowPack with defaults).
 *
 * Interactive only when ALL of the following hold:
 *   - stdin AND stdout are TTYs
 *   - no explicit --format / --json flag
 *   - no --yes / --non-interactive flag
 *   - SMITHERS_NONINTERACTIVE and SMITHERS_YES are unset
 *   - not a known CI environment
 *   - not a known agent-harness environment (read EARLY before harnesses clear env)
 *   - TERM is not "dumb"
 *
 * @param {{ options?: { json?: boolean; yes?: boolean; nonInteractive?: boolean }; format?: string; formatExplicit?: boolean }} c
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"interactive" | "non-interactive"}
 */
export function resolveInitMode(c, env = process.env) {
    if (c.options?.json || c.formatExplicit) return "non-interactive";
    if (c.options?.yes || c.options?.nonInteractive) return "non-interactive";
    if (env.SMITHERS_NONINTERACTIVE || env.SMITHERS_YES) return "non-interactive";
    if (isCI(env)) return "non-interactive";
    if (isAgentHarness(env)) return "non-interactive";
    if (env.TERM === "dumb") return "non-interactive";
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return "non-interactive";
    return "interactive";
}

/**
 * Build the "Next steps" call-to-action shown after init, tailored to whether
 * the user picked a starter template.
 *
 * @param {{ id: string; command: string } | undefined} templateResult
 */
function buildInitCta(templateResult) {
    return {
        description: "Next steps",
        commands: templateResult
            ? [
                { command: templateResult.command.replace(/^bunx smithers-orchestrator\s+/, ""), description: `Run ${templateResult.id}` },
                { command: "starters", description: "Browse the other templates" },
                { command: "workflow list", description: "View all available workflows" },
            ]
            : [
                { command: "workflow run hello", description: "Run your first workflow (edit .smithers/prompts/hello.mdx to change it)" },
                { command: "starters", description: "Browse templates by outcome" },
                { command: "workflow list", description: "View all available workflows" },
            ],
        tip: "New here? Your coding agent now has the smithers skill — just tell it what you want built (e.g. \"add rate limiting and keep iterating until the tests pass\").",
    };
}

/**
 * Re-run init THROUGH the engine once a pack exists: the seeded `init` system
 * workflow performs the same pack refresh as the imperative path, but as a
 * durable, replayable smithers run. First-time init cannot go through the
 * engine (the workflow file is itself a pack file), so bootstrap stays
 * imperative and every subsequent non-interactive `smithers init` upgrades to
 * the workflow. Returns null when the durable path is unavailable so the
 * caller falls back to the imperative scaffold.
 *
 * @param {{ force?: boolean; skipInstall?: boolean }} options
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function runDurableReinit(options) {
    const entryFile = resolve(process.cwd(), ".smithers", "workflows", "init.tsx");
    if (!existsSync(entryFile)) return null;
    try {
        const [{ Effect }, { runWorkflow }, { ensureSmithersTables }, { mdxPlugin }] = await Promise.all([
            import("effect"),
            import("@smithers-orchestrator/engine"),
            import("@smithers-orchestrator/db/ensure"),
            import("./mdx-plugin.js"),
        ]);
        mdxPlugin();
        const mod = await import(pathToFileURL(entryFile).href);
        const workflow = mod.default;
        if (!workflow) return null;
        ensureSmithersTables(workflow.db);
        const runId = crypto.randomUUID();
        let result;
        try {
            result = await Effect.runPromise(runWorkflow(workflow, {
                input: { force: options.force ?? false, skipInstall: options.skipInstall ?? false },
                runId,
                workflowPath: entryFile,
            }));
        }
        finally {
            // Close the workflow's DB handle so `smithers init` exits promptly
            // instead of the open sqlite handle keeping the event loop alive.
            const close = workflow.close ?? workflow.db?.close;
            if (typeof close === "function") {
                await close.call(workflow.close ? workflow : workflow.db);
            }
        }
        return {
            durable: true,
            workflow: "init",
            runId: result.runId,
            status: result.status,
            output: result.output ?? null,
        };
    }
    catch (err) {
        // Any failure (stale pack without the workflow's imports, missing deps,
        // broken user edits) falls back to the imperative scaffold — init must
        // never be blocked by the durable path.
        process.stderr.write(`[smithers:init] durable init workflow unavailable, falling back: ${err?.message ?? String(err)}\n`);
        return null;
    }
}

/**
 * @param {{ options: any; format?: string; ok: (...args: any[]) => any; error: (...args: any[]) => any }} c
 * @param {(opts: { code: string; message: string; exitCode?: number; details?: Record<string, unknown> }) => any} fail
 */
export async function runInitCommand(c, fail) {
    try {
        const human = resolveInitMode(c) === "interactive";
        const selectedTemplate = c.options.template ? findStarterRecipe(c.options.template) : undefined;
        // Non-interactive re-init on an existing pack runs as the durable `init`
        // system workflow instead of the one-shot imperative pass.
        if (!human && !c.options.agentsOnly && !c.options.global && !c.options.addAgents && !c.options.template) {
            const durable = await runDurableReinit({ force: c.options.force, skipInstall: !c.options.install });
            if (durable) {
                return c.ok(durable, { cta: { ...buildInitCta(undefined), description: "Next steps:" } });
            }
        }
        const result = human
            ? await runInitCeremony({
                force: c.options.force,
                agentsOnly: c.options.agentsOnly,
                install: c.options.install,
                global: c.options.global,
                installSkill: c.options.skill,
                updatePrompt: c.options.updatePrompt,
            })
            : initWorkflowPack({
                force: c.options.force,
                agentsOnly: c.options.agentsOnly,
                skipInstall: c.options.agentsOnly || !c.options.install,
                global: c.options.global,
                installSkill: c.options.skill,
            });
        const templateResult = selectedTemplate
            ? buildStarterGallery({ id: selectedTemplate.id }).selected
            : undefined;
        if (templateResult) {
            result.template = templateResult;
        }
        if (c.options.addAgents) {
            const added = await agentAddWizard({ loop: true });
            result.addedAccounts = added;
            // Regenerate agents.ts now that accounts are in place; the initial
            // generateAgentsTs() call ran before any accounts were registered.
            if (added.length > 0) {
                const { regenerateAgentsTsIfPresent } = await import("./agent-commands/regenerateAgentsTsIfPresent.js");
                result.regen = regenerateAgentsTsIfPresent();
            }
        }
        const cta = c.options.agentsOnly ? undefined : buildInitCta(templateResult);
        if (human) {
            // The ceremony already narrated the work; render the CTA inline and
            // suppress the structured dump via the command's agent-only policy.
            // Always terminate the ceremony: renderInitNextSteps emits the
            // closing clack outro() (even for an empty CTA, e.g. --agents-only),
            // matching the unconditional intro() in runInitCeremony.
            renderInitNextSteps(cta ?? { commands: [] });
            return c.ok(result);
        }
        return c.ok(result, cta ? { cta: { ...cta, description: "Next steps:" } } : undefined);
    }
    catch (err) {
        if (err instanceof SmithersError) {
            return fail({
                code: err.code,
                message: err.message,
                exitCode: 4,
            });
        }
        return fail({
            code: "INIT_FAILED",
            message: err?.message ?? String(err),
            exitCode: 1,
        });
    }
}
