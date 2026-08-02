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

function workspacePackageJsonPaths() {
  return ["packages", "apps"].flatMap((dir) =>
    readdirSync(resolve(REPO_ROOT, dir))
      .map((name) => `${dir}/${name}/package.json`)
      .filter((path) => existsSync(resolve(REPO_ROOT, path))),
  );
}

function extractTypeProps(source, typeName) {
  const props = tryExtractTypeProps(source, typeName);
  expect(props).not.toBeNull();
  return props;
}

function tryExtractTypeProps(source, typeName) {
  const markerIndex = source.indexOf(`type ${typeName}`);
  if (markerIndex < 0) return null;
  const declarationEnd = source.indexOf("\n", markerIndex);
  const openingBrace = source.lastIndexOf("{", declarationEnd);
  const closingBrace = source.indexOf("\n};", openingBrace);
  if (openingBrace <= markerIndex || closingBrace <= openingBrace) return null;

  const propertyLines = source
    .slice(openingBrace + 1, closingBrace)
    .split("\n")
    .map((line) => line.match(/^(\s+)([A-Za-z][A-Za-z0-9]*)\??:/u))
    .filter(Boolean);
  const firstIndent = propertyLines[0]?.[1];
  if (!firstIndent) return null;
  return new Set(propertyLines.filter((match) => match[1] === firstIndent).map((match) => match[2]));
}

function componentPropSourcePaths(dir = "packages/components/src") {
  return readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return componentPropSourcePaths(path);
    return entry.name.endsWith("Props.ts") ? [path] : [];
  });
}

function propIsDocumented(source, prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\`${escaped}\\??\`|\\b${escaped}\\??:)`, "u").test(source);
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

test("component reference docs cover exported components", () => {
  const smithersIndex = readRepoFile("packages/smithers/src/index.js");
  const componentExportBlock = smithersIndex.match(/export \{([^}]+)\} from "@smthrs\/components";/s)?.[1];
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
    // PascalCase only. The components barrel also re-exports SCREAMING_SNAKE
    // constants (MONITOR_CONDITIONS, …), which are values a component's props
    // are typed against, not components — they belong in that component's page,
    // not a page of their own.
    .filter((name) => /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name));
  exportedComponents.push("Trellis");

  const sagaDoc = readRepoFile("docs/components/saga.mdx");
  for (const component of exportedComponents) {
    if (component === "Ralph") {
      expect(loopDoc).toContain("Ralph");
      expect(loopDoc).toContain("deprecated alias");
      continue;
    }
    if (component === "SagaStep") {
      // SagaStep is the `<Saga.Step>` marker, documented inside saga.mdx
      // rather than its own page.
      expect(sagaDoc).toContain("SagaStep");
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
    "OpenClawAgentOptions.ts",
    "OpenCodeAgentOptions.ts",
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
});

test("package configuration docs cover current explicit package exports", () => {
  const packageConfigDoc = readRepoFile("docs/reference/package-configuration.mdx");
  const packageJson = JSON.parse(readRepoFile("packages/smithers/package.json"));
  const explicitImportPaths = Object.keys(packageJson.exports)
    .filter((subpath) => subpath !== "./*")
    .map((subpath) => (subpath === "." ? "smthrs" : `smthrs/${subpath.slice(2)}`));

  for (const importPath of explicitImportPaths) {
    expect(packageConfigDoc).toContain(`| \`${importPath}\``);
  }

  expect(packageConfigDoc).not.toContain("| `smthrs/pi-plugin`");
  expect(packageConfigDoc).not.toContain("| `smthrs/pi-extension`");
});

test("package configuration docs cover published workspace packages", () => {
  const packageConfigDoc = readRepoFile("docs/reference/package-configuration.mdx");
  const workspacePackageTable = packageConfigDoc.slice(
    packageConfigDoc.indexOf("## Workspace Packages"),
    packageConfigDoc.indexOf("### Usage"),
  );
  const packageJsonPaths = workspacePackageJsonPaths();
  const packageNames = packageJsonPaths.map((path) => JSON.parse(readRepoFile(path)).name).sort();

  for (const packageName of packageNames) {
    const rowStart = `| \`${packageName}\` |`;
    expect(workspacePackageTable.split(rowStart).length - 1).toBe(1);
  }
});

test("feature inventory covers every spec record and local docs reference", () => {
  const features = JSON.parse(readRepoFile(".smithers/spec/features.json"));
  const inventory = readRepoFile("docs/reference/feature-inventory.mdx");
  const inventoryRows = [...inventory.matchAll(/^\| `([a-z0-9-]+)` \| ([^|]+?) \| `([a-z]+)` \| `([a-z]+)` \|/gm)].map(
    (match) => ({ id: match[1], title: match[2].trim(), status: match[3], tier: match[4] }),
  );
  const inventoryIds = inventoryRows.map((row) => row.id);
  const inventoryById = new Map(inventoryRows.map((row) => [row.id, row]));
  const featureIds = features.map((feature) => feature.id);

  expect(inventoryIds.length).toBe(new Set(inventoryIds).size);
  expect([...inventoryIds].sort()).toEqual([...featureIds].sort());

  for (const feature of features) {
    expect(inventoryById.get(feature.id)).toMatchObject({
      title: feature.title,
      status: feature.status,
      tier: feature.tier,
    });
    const mintlifyRefs = [
      ...feature.endpoints.map((entry) => entry.doc).filter(Boolean),
      ...feature.links.map((entry) => entry.href),
    ].filter((path) => /^docs\/.*\.mdx(?:#.*)?$/u.test(path));
    expect(mintlifyRefs.length).toBeGreaterThan(0);
    for (const path of mintlifyRefs) {
      expect(existsSync(resolve(REPO_ROOT, path.split("#", 1)[0]))).toBe(true);
    }

    for (const testPath of feature.tests) {
      if (testPath.includes("*") || testPath.includes(" ")) continue;
      expect(existsSync(resolve(REPO_ROOT, testPath))).toBe(true);
    }

    for (const hint of feature.diffHints) {
      // dot: true — bun 1.3.x treats a LITERAL dot-prefixed segment
      // (.smithers/workflows/*.tsx) as hidden and matches nothing.
      const exists = hint.includes("*")
        ? Array.from(new Bun.Glob(hint).scanSync({ cwd: REPO_ROOT, onlyFiles: false, dot: true })).length > 0
        : existsSync(resolve(REPO_ROOT, hint));
      expect(exists, `${feature.id} diffHint should resolve: ${hint}`).toBe(true);
    }
  }
});

test("feature spec covers public packages and excludes private apps and example workflows", () => {
  const features = JSON.parse(readRepoFile(".smithers/spec/features.json"));
  const featureStrings = collectStrings(features);
  const workspacePackages = workspacePackageJsonPaths().map((path) => ({
    path,
    manifest: JSON.parse(readRepoFile(path)),
  }));
  const publicPackages = workspacePackages
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ path }) => path.replace(/\/package\.json$/u, ""));
  const privateApps = workspacePackages
    .filter(({ path, manifest }) => path.startsWith("apps/") && manifest.private === true)
    .map(({ path }) => path.replace(/\/package\.json$/u, ""));
  const exampleWorkflows = readdirSync(resolve(REPO_ROOT, ".smithers/workflows"))
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /^\/\/\s*smithers-source:\s*example\b/m.test(readRepoFile(`.smithers/workflows/${name}`)))
    .map((name) => `.smithers/workflows/${name}`);

  for (const packagePath of publicPackages) {
    expect(featureStrings.some((value) => value === packagePath || value.startsWith(`${packagePath}/`))).toBe(true);
  }
  for (const excludedPath of [...privateApps, ...exampleWorkflows]) {
    expect(
      featureStrings.some((value) => value === excludedPath || value.startsWith(`${excludedPath}/`)),
      `${excludedPath} should stay outside the core feature ledger`,
    ).toBe(false);
  }
});

test("component prop guides cover source prop types", () => {
  const typesReference = readRepoFile("docs/reference/types.mdx");
  const cases = [
    ["TaskProps", "packages/components/src/components/TaskProps.ts", "docs/components/task.mdx", "type"],
    ["SequenceProps", "packages/components/src/components/SequenceProps.ts", "docs/components/sequence.mdx", "type"],
    ["ParallelProps", "packages/components/src/components/ParallelProps.ts", "docs/components/parallel.mdx", "type"],
    ["MemoryProps", "packages/components/src/components/MemoryProps.ts", "docs/components/memory.mdx", "table"],
    [
      "TrellisProps",
      "packages/components/src/components/delegation-v2/TrellisProps.ts",
      "docs/components/trellis.mdx",
      "type",
    ],
  ];

  for (const [typeName, sourcePath, docPath, docKind] of cases) {
    const sourceProps = extractTypeProps(readRepoFile(sourcePath), typeName);
    sourceProps.delete("smithersContext");
    const componentDoc = readRepoFile(docPath);
    const componentProps =
      docKind === "table"
        ? new Set([...componentDoc.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)].map((match) => match[1]))
        : extractTypeProps(componentDoc, typeName);
    const referenceProps = extractTypeProps(typesReference, typeName);

    for (const prop of sourceProps) {
      expect(componentProps.has(prop)).toBe(true);
      expect(referenceProps.has(prop)).toBe(true);
    }
  }
});

test("all concrete component prop sources remain represented in guides and types", () => {
  const typesReference = readRepoFile("docs/reference/types.mdx");

  for (const sourcePath of componentPropSourcePaths()) {
    const componentName = sourcePath.match(/\/([^/]+)Props\.ts$/u)?.[1];
    expect(componentName).toBeTruthy();
    const typeName = `${componentName}Props`;
    const sourceProps = tryExtractTypeProps(readRepoFile(sourcePath), typeName);
    if (!sourceProps) continue; // aliases such as BackpressurePlanningProps = DelegationSharedProps
    sourceProps.delete("smithersContext");

    const docName = sourcePath.includes("/delegation/")
      ? "delegation-chain"
      : componentName === "Ralph"
        ? "loop"
        : componentName === "SagaStep"
          ? "saga"
          : kebabCase(componentName);
    const docPath = `docs/components/${docName}.mdx`;
    expect(existsSync(resolve(REPO_ROOT, docPath))).toBe(true);
    const componentDoc = readRepoFile(docPath);

    for (const prop of sourceProps) {
      expect(propIsDocumented(componentDoc, prop), `${typeName}.${prop} is missing from ${docPath}`).toBe(true);
      expect(
        propIsDocumented(typesReference, prop),
        `${typeName}.${prop} is missing from docs/reference/types.mdx`,
      ).toBe(true);
    }
  }
});

test("Mintlify navigation and LLM manifests expose complete public reference surfaces", () => {
  const docsJson = readRepoFile("docs/docs.json");
  const llmsManifest = readRepoFile("scripts/generate-llms.ts");
  const navigatedFamilies = ["components", "rpc"];

  for (const family of navigatedFamilies) {
    const pages = readdirSync(resolve(REPO_ROOT, `docs/${family}`))
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => `${family}/${file.replace(/\.mdx$/u, "")}`);
    for (const page of pages) expect(docsJson).toContain(`"${page}"`);
  }

  for (const page of [
    "concepts/provenance.mdx",
    "components/trellis.mdx",
    "guides/testing-workflows.mdx",
    "runtime/browser.mdx",
    "reference/feature-inventory.mdx",
  ]) {
    expect(llmsManifest).toContain(`"${page}"`);
  }
});

test("TUI guide documents the current interactive commands", () => {
  const tuiGuide = readRepoFile("docs/guides/tui.mdx");

  expect(tuiGuide).not.toContain("[`gui`](/cli/overview)");
  expect(tuiGuide).not.toMatch(/\bgui command\b/i);
  expect(tuiGuide).toContain("bunx smthrs init");
  expect(tuiGuide).toContain("bunx smthrs up --interactive");
  expect(tuiGuide).toContain("bunx smthrs workflow run WORKFLOW_ID --interactive");
  expect(tuiGuide).toContain("/images/tui/interactive-monitor-hello.svg");
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
  const gatewayRpcSource = readRepoFile("packages/protocol/src/gatewayRpcTypes.ts");
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

test("workflow overview, catalog, and sidebar cover the curated pack", () => {
  const workflowDocIds = ["create-skill", "create-workflow", "docs-driven-development"];

  const overview = readRepoFile("docs/workflows/overview.mdx");
  const catalog = readRepoFile("docs/workflows/catalog.mdx");
  const docsJson = readRepoFile("docs/docs.json");

  const overviewWorkflowIds = [...overview.matchAll(/\[`([a-z0-9-]+)`\]\(\/workflows\/\1\)/g)]
    .map((match) => match[1])
    .sort();
  const catalogWorkflowIds = [
    ...new Set(
      [...catalog.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]).filter((id) => workflowDocIds.includes(id)),
    ),
  ].sort();
  const sidebarWorkflowIds = [...docsJson.matchAll(/"workflows\/([a-z0-9-]+)"/g)]
    .map((match) => match[1])
    .filter((id) => id !== "overview" && id !== "catalog" && id !== "authoring-rules")
    .sort();

  expect(overviewWorkflowIds).toEqual(workflowDocIds);
  expect(catalogWorkflowIds).toEqual(workflowDocIds);
  expect(sidebarWorkflowIds).toEqual(
    [...workflowDocIds, "add", "eval-suite-run", "init", "post-failure", "share-pack", "upgrade"].sort(),
  );
});

test("error reference docs cover current Smithers error registry", () => {
  const errorSource = readRepoFile("packages/errors/src/smithersErrorDefinitions.js");
  const errorDoc = readRepoFile("docs/reference/errors.mdx");
  const documentedErrorSection = errorDoc.slice(errorDoc.indexOf("## Engine"), errorDoc.indexOf("## HTTP API Errors"));
  // Any leading indent: only the top-level codes are UPPER_SNAKE keys opening
  // a block, so this survives a reindent of the definitions file.
  const sourceCodes = new Set([...errorSource.matchAll(/^\s+([A-Z0-9_]+):\s*\{/gm)].map((match) => match[1]));
  const documentedCodes = new Set(
    [...documentedErrorSection.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((match) => match[1]),
  );

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
  const categorizedEvents = new Set(
    [...eventCategoryMapSource.matchAll(/^\s+([A-Za-z0-9]+): /gm)].map((match) => match[1]),
  );

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
  expect(docs).toContain("JSON is the only request body media type");
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

test("memory docs cover current MemoryStore method names", () => {
  const memoryStoreSource = readRepoFile("packages/memory/src/store/MemoryStore.ts");
  const docs = `${readRepoFile("docs/concepts/memory.mdx")}\n${readRepoFile("docs/reference/types.mdx")}`;
  const methodNames = [...memoryStoreSource.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)(?:\??:|\()/gm)].map(
    (match) => match[1],
  );

  for (const methodName of methodNames) {
    expect(docs).toContain(methodName);
  }

  expect(docs).not.toContain("store.recall");
  expect(docs).not.toContain("memory recall");
});

test("scorer docs mention current public scorer exports", () => {
  const scorerIndex = readRepoFile("packages/scorers/src/index.js");
  const docs = `${readRepoFile("docs/how-it-works.mdx")}\n${readRepoFile("docs/reference/types.mdx")}\n${readRepoFile("docs/reference/scorers.mdx")}`;
  const exportNames = [...scorerIndex.matchAll(/export \{([^}]+)\}/g)]
    .flatMap((match) => match[1].split(","))
    .map((name) => name.trim())
    .filter((name) => name && !name.startsWith("type "));

  for (const exportName of exportNames) {
    expect(docs).toContain(exportName);
  }
});
