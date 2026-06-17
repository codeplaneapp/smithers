import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SEMANTIC_TOOL_NAMES, createSemanticToolDefinitions, } from "./semantic-tools.js";
/** @typedef {import("./SemanticMcpServerOptions.ts").SemanticMcpServerOptions} SemanticMcpServerOptions */
/** @typedef {import("./SemanticToolDefinition.ts").SemanticToolDefinition} SemanticToolDefinition */

const SEMANTIC_TOOL_NAME_SET = new Set(SEMANTIC_TOOL_NAMES);

/**
 * @param {SemanticToolDefinition[]} toolDefinitions
 */
function validateSemanticToolDefinitions(toolDefinitions) {
    const seen = new Set();
    for (const tool of toolDefinitions) {
        if (!SEMANTIC_TOOL_NAME_SET.has(tool.name)) {
            throw new Error(`Unknown semantic MCP tool: ${tool.name}`);
        }
        if (!tool.annotations || typeof tool.annotations !== "object") {
            throw new Error(`Missing annotations for semantic MCP tool: ${tool.name}`);
        }
        if (seen.has(tool.name)) {
            throw new Error(`Duplicate semantic MCP tool: ${tool.name}`);
        }
        seen.add(tool.name);
    }
}

/**
 * @param {SemanticToolDefinition[]} toolDefinitions
 * @param {Pick<SemanticMcpServerOptions, "allowedTools" | "readOnly">} options
 */
function scopeSemanticToolDefinitions(toolDefinitions, options) {
    const allowed = options.allowedTools
        ? new Set(options.allowedTools)
        : null;
    if (allowed) {
        for (const toolName of allowed) {
            if (!SEMANTIC_TOOL_NAME_SET.has(toolName)) {
                throw new Error(`Unknown semantic MCP tool: ${toolName}`);
            }
        }
    }
    return toolDefinitions.filter((tool) => {
        if (allowed && !allowed.has(tool.name)) {
            return false;
        }
        if (options.readOnly && tool.annotations.readOnlyHint !== true) {
            return false;
        }
        return true;
    });
}

/**
 * @param {McpServer} server
 * @param {SemanticToolDefinition[]} [toolDefinitions]
 * @param {Pick<SemanticMcpServerOptions, "allowedTools" | "readOnly">} [options]
 */
export function registerSemanticTools(server, toolDefinitions = createSemanticToolDefinitions(), options = {}) {
    validateSemanticToolDefinitions(toolDefinitions);
    for (const tool of scopeSemanticToolDefinitions(toolDefinitions, options)) {
        server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
        }, async (input) => tool.handler(input));
    }
    return server;
}
/**
 * @param {SemanticMcpServerOptions} [options]
 */
export function createSemanticMcpServer(options = {}) {
    const server = new McpServer({
        name: options.name ?? "smithers",
        version: options.version ?? "0.0.0",
    });
    registerSemanticTools(server, createSemanticToolDefinitions(), options);
    return server;
}
/**
 * @param {SemanticMcpServerOptions} [options]
 */
export async function serveSemanticMcpServer(options = {}) {
    const server = createSemanticMcpServer(options);
    const transport = new StdioServerTransport(process.stdin, process.stdout);
    await server.connect(transport);
    return server;
}
