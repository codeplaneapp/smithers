import { describe, expect, test } from "bun:test";
import { createSmithersAgentContract } from "../src/agent-contract/index.js";
/**
 * @param {string} text
 */
function extractBacktickedNames(text) {
    return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}
describe("smithers agent contract", () => {
    test("contract renderer only references provided tools", () => {
        for (const toolSurface of ["semantic", "raw"]) {
            const contract = createSmithersAgentContract({
                serverName: "smithers",
                toolSurface,
                tools: [
                    {
                        name: "list_workflows",
                        description: "List discovered local Smithers workflows.",
                    },
                    {
                        name: "run_workflow",
                        description: "Start a discovered workflow directly through the engine.",
                    },
                    {
                        name: "list_runs",
                        description: "List recent Smithers runs with stable structured summaries.",
                    },
                    {
                        name: "get_run",
                        description: "Get enriched structured state for a specific run.",
                    },
                    {
                        name: "cancel",
                        description: "Destructive: cancel a running Smithers run.",
                    },
                ],
            });
            const toolNames = new Set(contract.tools.map((tool) => tool.name));
            const mentionedToolNames = new Set([
                ...extractBacktickedNames(contract.promptGuidance),
                ...extractBacktickedNames(contract.docsGuidance),
            ]);
            const staleMentions = [...mentionedToolNames].filter((name) => !toolNames.has(name));
            expect(staleMentions).toEqual([]);
        }
    });
});
