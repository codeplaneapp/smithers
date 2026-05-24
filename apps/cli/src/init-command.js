import { z } from "incur";
import { SmithersError } from "@smithers-orchestrator/errors";
import { agentAddWizard } from "./agent-commands/agentAddWizard.js";
import { STARTER_TEMPLATE_IDS, buildStarterGallery, findStarterRecipe } from "./starter-gallery.js";
import { initWorkflowPack } from "./workflow-pack.js";

const initTemplateOption = z
    .union(STARTER_TEMPLATE_IDS.map((id) => z.literal(id)))
    .optional()
    .describe("Show next steps for a canonical starter template ID after init");

export const initOptions = z.object({
    force: z.boolean().default(false).describe("Overwrite existing scaffold files"),
    agentsOnly: z.boolean().default(false).describe("Only create .smithers/agents/ and leave the rest of the workflow pack untouched"),
    install: z.boolean().default(true).describe("Run `bun install` inside .smithers/ after scaffolding (--no-install to skip)"),
    addAgents: z.boolean().default(false).describe("After scaffolding, launch the interactive `agents add` wizard to register one or more accounts."),
    template: initTemplateOption,
});

/**
 * @param {{ options: any; ok: (...args: any[]) => any; error: (...args: any[]) => any }} c
 * @param {(opts: { code: string; message: string; exitCode?: number; details?: Record<string, unknown> }) => any} fail
 */
export async function runInitCommand(c, fail) {
    try {
        const selectedTemplate = c.options.template ? findStarterRecipe(c.options.template) : undefined;
        const result = initWorkflowPack({
            force: c.options.force,
            agentsOnly: c.options.agentsOnly,
            skipInstall: c.options.agentsOnly || !c.options.install,
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
        return c.ok(result, c.options.agentsOnly
            ? undefined
            : {
                cta: {
                    description: "Next steps:",
                    commands: templateResult
                        ? [
                            { command: templateResult.command.replace(/^bunx smithers-orchestrator\s+/, ""), description: `Run ${templateResult.id}` },
                            { command: "starters", description: "Browse the other templates" },
                            { command: "workflow list", description: "View all available workflows" },
                        ]
                        : [
                            { command: "init --template <id>", description: "Start from a guided template" },
                            { command: "starters", description: "Browse templates by outcome" },
                            { command: "workflow list", description: "View all available workflows" },
                        ],
                },
            });
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
