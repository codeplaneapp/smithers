import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Cli, Mcp as IncurMcp } from "incur";
import { parseMcpSurfaceArgv } from "../argv-utils.js";
import { createSemanticMcpServer } from "./semantic-server.js";

/**
 * @param {ReturnType<typeof createSemanticMcpServer>} server
 * @param {{ cli: unknown }} options
 */
export function registerRawToolsOnMcpServer(server, options) {
    const commands = Cli.toCommands?.get(options.cli);
    if (!(commands instanceof Map)) {
        throw new Error("Could not resolve Smithers CLI commands for raw MCP surface.");
    }
    for (const tool of IncurMcp.collectTools(commands, [])) {
        const mergedShape = {
            ...tool.command.args?.shape,
            ...tool.command.options?.shape,
        };
        const hasInput = Object.keys(mergedShape).length > 0;
        server.registerTool(tool.name, {
            ...(tool.description ? { description: tool.description } : undefined),
            ...(hasInput ? { inputSchema: mergedShape } : undefined),
        }, async (...callArgs) => {
            const params = hasInput ? callArgs[0] : {};
            const extra = hasInput ? callArgs[1] : callArgs[0];
            return IncurMcp.callTool(tool, params, extra);
        });
    }
}

/**
 * Serve the CLI's MCP entrypoint when `--mcp` is present.
 *
 * @param {string[]} argv
 * @param {{
 *   cli: { serve: Function };
 *   version: string;
 *   stdin?: NodeJS.ReadableStream;
 *   stdout?: NodeJS.WritableStream;
 * }} options
 * @returns {Promise<boolean>}
 */
export async function runMcpModeIfRequested(argv, options) {
    if (!argv.includes("--mcp")) {
        return false;
    }
    try {
        const mcpArgs = parseMcpSurfaceArgv(argv);
        if (mcpArgs.surface === "raw") {
            await options.cli.serve(mcpArgs.argv);
        }
        else {
            const server = createSemanticMcpServer({
                name: "smithers",
                version: options.version,
                allowedTools: mcpArgs.allowedTools,
                readOnly: mcpArgs.readOnly,
            });
            if (mcpArgs.surface === "both") {
                registerRawToolsOnMcpServer(server, { cli: options.cli });
            }
            const transport = new StdioServerTransport(options.stdin ?? process.stdin, options.stdout ?? process.stdout);
            await server.connect(transport);
        }
    }
    catch (err) {
        console.error(err?.message ?? String(err));
        process.exit(1);
    }
    return true;
}
