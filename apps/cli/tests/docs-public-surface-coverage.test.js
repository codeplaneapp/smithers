import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

function readRepoFile(path) {
    return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function kebabCase(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function parseNamedExports(source) {
    return [...source.matchAll(/export\s+\{([^}]+)\}/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim().replace(/\s+as\s+.*$/u, ""))
        .filter(Boolean);
}

test("component reference docs cover exported components", () => {
    const smithersIndex = readRepoFile("packages/smithers/src/index.js");
    const componentExportBlock = smithersIndex.match(
        /export \{([^}]+)\} from "@smithers-orchestrator\/components";/s,
    )?.[1];
    expect(componentExportBlock).toBeTruthy();

    const componentDocs = new Set(
        readdirSync(resolve(REPO_ROOT, "docs/components"))
            .filter((file) => file.endsWith(".mdx"))
            .map((file) => file.replace(/\.mdx$/, "")),
    );
    const loopDoc = readRepoFile("docs/components/loop.mdx");
    const exportedComponents = componentExportBlock
        .split(",")
        .map((name) => name.trim())
        .filter((name) => /^[A-Z]/.test(name));

    for (const component of exportedComponents) {
        if (component === "Ralph") {
            expect(loopDoc).toContain("Ralph");
            expect(loopDoc).toContain("deprecated alias");
            continue;
        }
        expect(componentDocs.has(kebabCase(component))).toBe(true);
    }
});

test("agent integration docs cover exported agent classes", () => {
    const agentsIndex = readRepoFile("packages/agents/src/index.js");
    const cliAgentDoc = readRepoFile("docs/integrations/cli-agents.mdx");
    const sdkAgentDoc = readRepoFile("docs/integrations/sdk-agents.mdx");
    const documentedAgents = `${cliAgentDoc}\n${sdkAgentDoc}`;
    const exportedAgents = parseNamedExports(agentsIndex)
        .filter((name) => /^[A-Z][A-Za-z]+Agent$/.test(name))
        .filter((name) => name !== "BaseCliAgent");

    for (const agent of exportedAgents) {
        expect(documentedAgents).toContain(agent);
    }
});

test("CLI agent docs mention current agent-specific option names", () => {
    const cliAgentDoc = readRepoFile("docs/integrations/cli-agents.mdx");
    const optionFiles = [
        "AmpAgentOptions.ts",
        "AntigravityAgentOptions.ts",
        "ClaudeCodeAgentOptions.ts",
        "CodexAgentOptions.ts",
        "ForgeAgentOptions.ts",
        "GeminiAgentOptions.ts",
        "KimiAgentOptions.ts",
        "PiAgentOptions.ts",
        "VibeAgentOptions.ts",
    ];

    for (const file of optionFiles) {
        const source = readRepoFile(`packages/agents/src/${file}`);
        const optionNames = [...source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((match) => match[1]);
        for (const optionName of optionNames) {
            expect(cliAgentDoc).toContain(optionName);
        }
    }

    const openCodeSource = readRepoFile("packages/agents/src/OpenCodeAgent.ts");
    const openCodeOptionsBlock = openCodeSource.match(/export type OpenCodeAgentOptions = BaseCliAgentOptions & \{([\s\S]*?)\};/)?.[1];
    expect(openCodeOptionsBlock).toBeTruthy();
    const openCodeOptionNames = [...openCodeOptionsBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((match) => match[1]);
    for (const optionName of openCodeOptionNames) {
        expect(cliAgentDoc).toContain(optionName);
    }
});

test("package configuration docs cover current explicit package exports", () => {
    const packageConfigDoc = readRepoFile("docs/reference/package-configuration.mdx");
    const packageJson = JSON.parse(readRepoFile("packages/smithers/package.json"));
    const explicitImportPaths = Object.keys(packageJson.exports)
        .filter((subpath) => subpath !== "./*")
        .map((subpath) => (subpath === "." ? "smithers-orchestrator" : `smithers-orchestrator/${subpath.slice(2)}`));

    for (const importPath of explicitImportPaths) {
        expect(packageConfigDoc).toContain(`| \`${importPath}\``);
    }

    expect(packageConfigDoc).not.toContain("| `smithers-orchestrator/pi-plugin`");
    expect(packageConfigDoc).not.toContain("| `smithers-orchestrator/pi-extension`");
});

test("package configuration docs cover published workspace packages", () => {
    const packageConfigDoc = readRepoFile("docs/reference/package-configuration.mdx");
    const packageJsonPaths = ["packages", "apps"].flatMap((dir) =>
        readdirSync(resolve(REPO_ROOT, dir))
            .map((name) => `${dir}/${name}/package.json`)
            .filter((path) => existsSync(resolve(REPO_ROOT, path))),
    );
    const packageNames = packageJsonPaths
        .map((path) => JSON.parse(readRepoFile(path)).name)
        .sort();

    for (const packageName of packageNames) {
        expect(packageConfigDoc).toContain(`| \`${packageName}\``);
    }
});

test("TUI removal guide does not point at the retired gui command", () => {
    const tuiGuide = readRepoFile("docs/guides/tui.mdx");

    expect(tuiGuide).not.toContain("[`gui`](/cli/overview)");
    expect(tuiGuide).not.toMatch(/\bgui command\b/i);
    expect(tuiGuide).toContain("| Local control plane |");
    expect(tuiGuide).toContain("[`ps --watch`](/cli/overview)");
    expect(tuiGuide).toContain("[`inspect --watch`](/cli/overview)");
});

test("MCP semantic tool docs cover current semantic tools", () => {
    const semanticToolsSource = readRepoFile("apps/cli/src/mcp/semantic-tools.js");
    const mcpDoc = readRepoFile("docs/integrations/mcp-server.mdx");
    const namesBlock = semanticToolsSource.match(/export const SEMANTIC_TOOL_NAMES = \[([\s\S]*?)\];/)?.[1];
    expect(namesBlock).toBeTruthy();

    const toolNames = [...namesBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    for (const toolName of toolNames) {
        expect(mcpDoc).toContain(`### ${toolName}`);
    }
});

test("Gateway RPC docs cover current RPC methods", () => {
    const gatewayRpcSource = readRepoFile("packages/gateway/src/rpc/index.ts");
    const methodBlock = gatewayRpcSource.match(/export type GatewayRpcMethod =([\s\S]*?);/)?.[1];
    expect(methodBlock).toBeTruthy();

    const rpcDocFiles = new Set(
        readdirSync(resolve(REPO_ROOT, "docs/rpc"))
            .filter((file) => file.endsWith(".mdx"))
            .map((file) => file.replace(/\.mdx$/, "")),
    );
    const methods = [...methodBlock.matchAll(/\| "([A-Za-z]+)"/g)].map((match) => match[1]);
    for (const method of methods) {
        expect(rpcDocFiles.has(kebabCase(method))).toBe(true);
    }
});

test("seeded workflow docs cover current init workflow pack", () => {
    const workflowPackSource = readRepoFile("apps/cli/src/workflow-pack.js");
    const workflowDocs = new Set(
        readdirSync(resolve(REPO_ROOT, "docs/workflows"))
            .filter((file) => file.endsWith(".mdx"))
            .map((file) => file.replace(/\.mdx$/, "")),
    );
    const seededWorkflowIds = new Set(
        [...workflowPackSource.matchAll(/renderWorkflowFile\("([^"]+)"/g)].map((match) => match[1]),
    );

    if (workflowPackSource.includes('path: ".smithers/workflows/kanban.tsx"')) {
        seededWorkflowIds.add("kanban");
    }

    // Generator-seeded workflows (emitted by scripts/generate-workflow-pack.ts and
    // spliced in via GENERATED_SEEDED_FILES) must satisfy the same docs invariant,
    // otherwise the generator becomes a way to bypass docs coverage. Match only the
    // quoted seeded file paths ("path": ".smithers/workflows/<id>.tsx"); a loose
    // match also catches `.smithers/workflows/...` inside the embedded workflow
    // SOURCE (comments, runtime-generated child paths like smithering-impl) and
    // manufactures workflow ids that were never seeded.
    const generatedSeeds = readRepoFile("apps/cli/src/seeded-workflow-pack.generated.js");
    for (const match of generatedSeeds.matchAll(/"\.smithers\/workflows\/([a-z0-9-]+)\.tsx"/g)) {
        seededWorkflowIds.add(match[1]);
    }

    for (const workflowId of seededWorkflowIds) {
        expect(workflowDocs.has(workflowId)).toBe(true);
    }
});

test("error reference docs cover current Smithers error registry", () => {
    const errorSource = readRepoFile("packages/errors/src/smithersErrorDefinitions.js");
    const errorDoc = readRepoFile("docs/reference/errors.mdx");
    const documentedErrorSection = errorDoc
        .slice(errorDoc.indexOf("## Engine"), errorDoc.indexOf("## HTTP API Errors"));
    const sourceCodes = new Set([...errorSource.matchAll(/^\s{4}([A-Z0-9_]+): \{/gm)].map((match) => match[1]));
    const documentedCodes = new Set([...documentedErrorSection.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((match) => match[1]));

    expect([...documentedCodes].sort()).toEqual([...sourceCodes].sort());
});

test("event reference docs and categories cover current Smithers events", () => {
    const eventSource = readRepoFile("apps/observability/src/SmithersEvent.ts");
    const eventUnionSource = eventSource.slice(eventSource.indexOf("export type SmithersEvent ="));
    const eventDoc = readRepoFile("docs/reference/event-types.mdx");
    const eventCategories = readRepoFile("apps/cli/src/event-categories.js");
    const eventCategoryMapSource = eventCategories.slice(
        eventCategories.indexOf("const EVENT_CATEGORY_BY_TYPE"),
        eventCategories.indexOf("const CATEGORY_ALIASES"),
    );
    const sourceEvents = new Set([...eventUnionSource.matchAll(/type: "([^"]+)";/g)].map((match) => match[1]));
    const documentedEvents = new Set([...eventDoc.matchAll(/^\| `([A-Za-z0-9]+)` \|/gm)].map((match) => match[1]));
    const categorizedEvents = new Set([...eventCategoryMapSource.matchAll(/^\s{4}([A-Za-z0-9]+): /gm)].map((match) => match[1]));

    expect([...documentedEvents].sort()).toEqual([...sourceEvents].sort());
    expect([...categorizedEvents].sort()).toEqual([...sourceEvents].sort());
});

test("OpenAPI docs cover current tool option names", () => {
    const optionsSource = readRepoFile("packages/openapi/src/OpenApiToolsOptions.ts");
    const docs = `${readRepoFile("docs/concepts/openapi-tools.mdx")}\n${readRepoFile("docs/reference/types.mdx")}`;
    const optionNames = [...optionsSource.matchAll(/^\s{1,2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((match) => match[1]);

    for (const optionName of optionNames) {
        expect(docs).toContain(optionName);
    }

    expect(docs).not.toContain("includeOperations");
    expect(docs).not.toContain("excludeOperations");
    expect(docs).not.toContain("basicAuth");
});

test("OpenAPI docs document current package limitations", () => {
    const docs = readRepoFile("docs/concepts/openapi-tools.mdx");

    expect(docs).toContain("## Notes / Limitations");
    expect(docs).toContain("Cookie parameters");
    expect(docs).toContain("JSON request bodies");
    expect(docs).toContain("Parameter serialization styles");
    expect(docs).toContain("Swagger 2.0");
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});

test("OpenAPI docs document current package limitations", () => {
    const docs = readRepoFile("docs/concepts/openapi-tools.mdx");

    expect(docs).toContain("## Notes / Limitations");
    expect(docs).toContain("Cookie parameters");
    expect(docs).toContain("JSON request bodies");
    expect(docs).toContain("Parameter serialization styles");
    expect(docs).toContain("Swagger 2.0");
});

test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});
test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});

test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});

test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});

test("community connector spec documents the long-tail package contract", () => {
    const docsConfig = readRepoFile("docs/docs.json");
    expect(docsConfig).toContain("integrations/community-connectors");

    const doc = readRepoFile("docs/integrations/community-connectors.mdx");
    const requiredSections = [
        "## Package Layout",
        "## Manifest Format",
        "## Loader Contract",
        "## Tool Declarations",
        "## Trigger Declarations",
        "## Auth Requirements",
        "## Tier 0 Integration Points",
        "## Anti-Patterns",
    ];
    const manifestKeys = [
        "smithers.connector.v1",
        "tools",
        "triggers",
        "auth",
        "surfaces",
        "oauth",
        "tokenBroker",
        "mcp",
        "openapi",
        "webhooks",
    ];
    const loaderTerms = [
        "validate the manifest",
        "project tools",
        "register triggers",
        "resolve auth",
        "enforce scopes",
        "idempotency",
    ];

    for (const section of requiredSections) expect(doc).toContain(section);
    for (const key of manifestKeys) expect(doc).toContain(key);
    for (const term of loaderTerms) expect(doc).toContain(term);
});

test("memory docs cover current MemoryStore method names", () => {
    const memoryStoreSource = readRepoFile("packages/memory/src/store/MemoryStore.ts");
    const docs = `${readRepoFile("docs/concepts/memory.mdx")}\n${readRepoFile("docs/reference/types.mdx")}`;
    const methodNames = [...memoryStoreSource.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)(?:\??:|\()/gm)].map((match) => match[1]);

    for (const methodName of methodNames) {
        expect(docs).toContain(methodName);
    }

    expect(docs).not.toContain("store.recall");
    expect(docs).not.toContain("memory recall");
});

test("scorer docs mention current public scorer exports", () => {
    const scorerIndex = readRepoFile("packages/scorers/src/index.js");
    const docs = `${readRepoFile("docs/how-it-works.mdx")}\n${readRepoFile("docs/reference/types.mdx")}`;
    const exportNames = [...scorerIndex.matchAll(/export \{([^}]+)\}/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim())
        .filter((name) => name && !name.startsWith("type "));

    for (const exportName of exportNames) {
        expect(docs).toContain(exportName);
    }
});
