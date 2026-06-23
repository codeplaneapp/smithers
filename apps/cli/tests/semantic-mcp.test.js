import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Cli, z } from "incur";
import { parseMcpSurfaceArgv } from "../src/argv-utils.js";
import { registerRawToolsOnMcpServer } from "../src/mcp/mcp-mode.js";
import { createSemanticMcpServer, registerSemanticTools, } from "../src/mcp/semantic-server.js";
import { SEMANTIC_TOOL_NAMES } from "../src/mcp/semantic-tools.js";
const servers = [];
const clients = [];
afterEach(async () => {
    while (clients.length > 0) {
        const client = clients.pop();
        if (client) {
            await client.close();
        }
    }
    while (servers.length > 0) {
        const server = servers.pop();
        if (server) {
            await server.close();
        }
    }
});
describe("semantic MCP surface", () => {
    test("parses scoped outbound MCP options for the production --mcp entrypoint", () => {
        expect(parseMcpSurfaceArgv([
            "--mcp",
            "--surface",
            "both",
            "--allowed-tools",
            "list_workflows, get_run,run_workflow",
            "--read-only",
        ])).toEqual({
            surface: "both",
            argv: ["--mcp"],
            allowedTools: ["list_workflows", "get_run", "run_workflow"],
            readOnly: true,
        });
    });

    test("listTools returns the semantic tool family only", async () => {
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
        });
        servers.push(server);
        const client = new Client({
            name: "smithers-semantic-test-client",
            version: "test",
        });
        clients.push(client);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name).sort();
        expect(names).toEqual([...SEMANTIC_TOOL_NAMES].sort());
    });

    test("can scope outbound discovery to explicitly allowed read-only semantic tools", async () => {
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
            allowedTools: ["list_workflows", "run_workflow", "get_run"],
            readOnly: true,
        });
        servers.push(server);
        const client = new Client({
            name: "smithers-semantic-test-client",
            version: "test",
        });
        clients.push(client);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            "get_run",
            "list_workflows",
        ]);
    });

    test("can register raw CLI tools on the semantic MCP server", async () => {
        const rawCli = Cli.create({
            name: "smithers-test",
            description: "Smithers test CLI",
            version: "test",
            mcp: { command: "smithers-test --mcp" },
        }).command("raw-ping", {
            description: "Raw ping test command",
            options: z.object({
                loud: z.boolean().default(false),
            }),
            run(c) {
                return c.ok({ loud: c.options.loud });
            },
        });
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
        });
        registerRawToolsOnMcpServer(server, { cli: rawCli });
        servers.push(server);
        const client = new Client({
            name: "smithers-semantic-test-client",
            version: "test",
        });
        clients.push(client);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);

        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name).sort();
        expect(names).toContain("list_workflows");
        expect(names).toContain("raw-ping");
    });

    test("rejects invalid semantic tool discovery definitions before serving", () => {
        const baseTool = {
            name: "list_workflows",
            description: "List workflows",
            inputSchema: {},
            outputSchema: {},
            annotations: { readOnlyHint: true },
            handler: async () => ({
                content: [],
                structuredContent: { ok: true, data: {} },
            }),
        };
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
            allowedTools: [],
        });

        expect(() => registerSemanticTools(server, [
            baseTool,
            { ...baseTool },
        ])).toThrow(/Duplicate semantic MCP tool/);
        expect(() => registerSemanticTools(server, [
            { ...baseTool, name: "shell" },
        ])).toThrow(/Unknown semantic MCP tool/);
    });
});
