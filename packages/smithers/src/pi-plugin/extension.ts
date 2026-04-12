/**
 * Smithers PI Extension
 *
 * Gives the PI coding agent full smithers knowledge and workflow observability.
 *
 * MCP bridge:
 *   - Spawns `smithers --mcp` as a child process
 *   - Bridges the live Smithers semantic MCP surface as `smithers_<tool>` PI tools
 *
 * System prompt:
 *   - Injects llms-full.txt (~125k tokens) so the LLM fully understands smithers
 *   - Injects contract-generated Smithers tool guidance plus active run context
 *
 * Commands (available to the user):
 *   /smithers          – Dashboard overlay (live-updating)
 *   /smithers-runs     – List all tracked runs
 *   /smithers-watch    – Attach live event stream to a run
 *   /smithers-approve  – Interactively approve/deny a waiting node
 *
 * UI:
 *   - Header: smithers branding
 *   - Footer: live run status with node progress
 *   - Widget: event stream ticker (above editor)
 *   - Custom message renderer for smithers events
 *   - Status bar: active run count + waiting approvals
 *
 * Observability:
 *   - Auto-polls active runs every 10s for status
 *   - Event stream subscription with reconnect
 *   - Duration tracking per node
 *   - Error aggregation
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type SmithersAgentContract } from "@smithers/agents/agent-contract";
export type SmithersPiRunContext = {
    runId: string;
    workflowName: string;
    status: string;
    nodeStates: Array<{
        nodeId: string;
        state: string;
    }>;
    errors: string[];
};
export declare function buildSmithersPiSystemPrompt(baseSystemPrompt: string, docs: string, contract: SmithersAgentContract, activeRun?: SmithersPiRunContext): string;
declare function declareExtension(pi: ExtensionAPI): void;
export default declareExtension;
