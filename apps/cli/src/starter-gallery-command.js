import { z } from "incur";
import { buildStarterGallery, findStarterRecipe, renderStarterGallery } from "./starter-gallery.js";

export const startersArgs = z.object({
    id: z.string().optional().describe("Starter ID or alias"),
});

export const startersOptions = z.object({
    audience: z.string().optional().describe("Filter by audience, such as product, support, or founder"),
    goal: z.string().optional().describe("Filter by goal, such as plan, build, debug, or quality"),
    workflow: z.string().optional().describe("Filter by seeded workflow ID"),
    tag: z.string().optional().describe("Filter by starter tag"),
});

/**
 * @param {{ args: any; options: any; format?: string; ok: (...args: any[]) => any; error: (...args: any[]) => any }} c
 * @param {(opts: { code: string; message: string; exitCode?: number; details?: Record<string, unknown> }) => any} fail
 */
export function runStartersCommand(c, fail) {
    if (c.args.id && !findStarterRecipe(c.args.id)) {
        return fail({
            code: "STARTER_NOT_FOUND",
            message: `Starter not found: ${c.args.id}. Run "bunx smithers-orchestrator starters" to list available starters.`,
            details: {
                availableStarters: buildStarterGallery().starters.map((starter) => starter.id),
            },
            exitCode: 4,
        });
    }
    const gallery = buildStarterGallery({
        id: c.args.id,
        audience: c.options.audience,
        goal: c.options.goal,
        workflow: c.options.workflow,
        tag: c.options.tag,
    });
    const explicitFormat = process.argv.some((arg) => arg === "--format" || arg.startsWith("--format="));
    if (explicitFormat || c.format === "json" || c.format === "jsonl") {
        return c.ok(gallery);
    }
    process.stdout.write(`${renderStarterGallery(gallery)}\n`);
    return undefined;
}
