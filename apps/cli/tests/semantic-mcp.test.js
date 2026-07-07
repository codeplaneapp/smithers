import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Cli, z } from "incur";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMcpSurfaceArgv } from "../src/argv-utils.js";
import { registerRawToolsOnMcpServer, runMcpModeIfRequested } from "../src/mcp/mcp-mode.js";
import { createSemanticMcpServer, registerSemanticTools, } from "../src/mcp/semantic-server.js";
import { createSemanticToolDefinitions, SEMANTIC_TOOL_NAMES } from "../src/mcp/semantic-tools.js";
const servers = [];
const clients = [];
const tempDirs = [];
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
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});
function tempCwd() {
    const root = join(process.cwd(), "tmp", "verification");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "smithers-semantic-mcp-"));
    tempDirs.push(dir);
    return dir;
}
describe("semantic MCP surface", () => {
    test("stdio mode only takes over when --mcp is requested and preserves raw CLI serving", async () => {
        let servedArgv = null;
        const cli = {
            serve: async (argv) => {
                servedArgv = argv;
            },
        };

        const skipped = await runMcpModeIfRequested(["workflow", "list"], {
            cli,
            version: "test",
        });
        expect(skipped).toBe(false);
        expect(servedArgv).toBeNull();

        const served = await runMcpModeIfRequested([
            "--mcp",
            "--surface",
            "raw",
            "--allowed-tools",
            "list_runs",
            "--read-only",
        ], {
            cli,
            version: "test",
        });
        expect(served).toBe(true);
        expect(servedArgv).toEqual(["--mcp"]);
    });

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

    test("forwards MCP request context to semantic tool handlers", async () => {
        let seenExtra = null;
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
            allowedTools: [],
        });
        registerSemanticTools(server, [
            {
                name: "list_workflows",
                description: "Test context forwarding",
                inputSchema: z.object({}),
                outputSchema: z.object({ ok: z.boolean() }),
                annotations: { readOnlyHint: true },
                handler: async (_input, extra) => {
                    seenExtra = extra;
                    return {
                        content: [{ type: "text", text: '{"ok":true}' }],
                        structuredContent: { ok: true },
                    };
                },
            },
        ]);
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

        await client.callTool({ name: "list_workflows", arguments: {} });
        expect(seenExtra).toBeTruthy();
        expect(seenExtra.signal).toBeInstanceOf(AbortSignal);
        expect(seenExtra.requestId).toBeDefined();
    });

    test("run_workflow validates the real workflow summary through Client.callTool", async () => {
        const cwd = tempCwd();
        mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(cwd, ".smithers", "workflows", "quick.tsx"), [
            "/** @jsxImportSource smithers-orchestrator */",
            'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
            'import { z } from "zod";',
            "const { smithers, outputs } = createSmithers({ result: z.object({ value: z.number() }) });",
            "export default smithers(() => (",
            '  <Workflow name="quick">',
            '    <Task id="answer" output={outputs.result}>',
            "      {{ value: 42 }}",
            "    </Task>",
            "  </Workflow>",
            "));",
            "",
        ].join("\n"));
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
            allowedTools: [],
        });
        registerSemanticTools(server, createSemanticToolDefinitions({ cwd: () => cwd }).filter((tool) => tool.name === "run_workflow"));
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

        const result = await client.callTool({
            name: "run_workflow",
            arguments: {
                workflowId: "quick",
                runId: "semantic-mcp-quick",
                waitForTerminal: true,
            },
        });
        expect(result.structuredContent.ok).toBe(true);
        expect(result.structuredContent.data.workflow.id).toBe("quick");
        expect(result.structuredContent.data.workflow.path).toBe(result.structuredContent.data.workflow.entryFile);
        expect(result.structuredContent.data.launchMode).toBe("waited");
        expect(result.structuredContent.data.status).toBe("finished");
    }, 30_000);

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
