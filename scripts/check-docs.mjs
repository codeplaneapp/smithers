#!/usr/bin/env node
/**
 * Docs lint gate. Fails CI when the docs drift from house style:
 *   - bare `smithers` / `bunx smithers` CLI invocations (must be
 *     `bunx smithers-orchestrator`)
 *   - hyphenated angle-bracket CLI placeholders (`<run-id>`, must be RUN_ID)
 *   - em-dashes (—)
 *
 * The first two reuse the fix scripts in `--check` mode (one source of truth
 * for detection and fixing). Run the matching fixer to resolve:
 *   bun scripts/normalize-bunx.ts
 *   bun scripts/normalize-placeholders.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(root, "docs");
const RPC_DOCS = join(DOCS, "rpc");
const HOW_IT_WORKS = join(DOCS, "how-it-works.mdx");
const README = join(root, "README.md");
const TIMER_COMPONENT_DOC = join(DOCS, "components/timer.mdx");
const SANDBOX_COMPONENT_DOC = join(DOCS, "components/sandbox.mdx");
const ERROR_DEFINITIONS = join(root, "packages/errors/src/smithersErrorDefinitions.js");
const SMITHERS_PACKAGE_JSON = join(root, "packages/smithers/package.json");
const SMITHERS_FACADE_SOURCE = join(root, "packages/smithers/src/index.js");
const SMITHERS_FACADE_DECLARATIONS = join(root, "packages/smithers/src/index.d.ts");
const SMITHERS_CREATE_SOURCE = join(root, "packages/smithers/src/create.js");
const SMITHERS_CREATE_API_SOURCE = join(root, "packages/smithers/src/CreateSmithersApi.ts");
const EXTERNAL_SMITHERS_CONFIG_SOURCE = join(root, "packages/smithers/src/external/ExternalSmithersConfig.ts");
const SERIALIZED_CTX_SOURCE = join(root, "packages/smithers/src/external/SerializedCtx.ts");
const HOST_NODE_JSON_SOURCE = join(root, "packages/smithers/src/external/HostNodeJson.ts");
const ERROR_REFERENCE = join(DOCS, "reference/errors.mdx");
const TYPES_REFERENCE = join(DOCS, "reference/types.mdx");
const CLI_OVERVIEW = join(DOCS, "cli/overview.mdx");
const CLI_ENTRYPOINT = join(root, "apps/cli/src/index.js");
const CLI_SUPERVISOR_SOURCE = join(root, "apps/cli/src/supervisor.js");
const MCP_SEMANTIC_TOOLS_SOURCE = join(root, "apps/cli/src/mcp/semantic-tools.js");
const TOOLS_INTEGRATION = join(DOCS, "integrations/tools.mdx");
const COMMON_TOOLS_INTEGRATION = join(DOCS, "integrations/common-tools.mdx");
const INTEGRATIONS_OVERVIEW = join(DOCS, "integrations/integrations.mdx");
const SERVER_INTEGRATION = join(DOCS, "integrations/server.mdx");
const SERVER_SOURCE = join(root, "packages/server/src/index.js");
const SERVER_GATEWAY_SOURCE = join(root, "packages/server/src/gateway.js");
const GATEWAY_INTEGRATION = join(DOCS, "integrations/gateway.mdx");
const CUSTOM_UI_INTEGRATION = join(DOCS, "integrations/custom-ui.mdx");
const CUSTOM_WORKFLOW_UI_GUIDE = join(DOCS, "guides/custom-workflow-ui.mdx");
const ALERTING_GUIDE = join(DOCS, "guides/alerting.mdx");
const CONTROL_PLANE_GUIDE = join(DOCS, "deployment/control-plane.mdx");
const PRODUCTION_HARDENING_GUIDE = join(DOCS, "deployment/production-hardening.mdx");
const REFERENCE_DEPLOYMENT_GUIDE = join(DOCS, "deployment/reference.mdx");
const OPENAPI_CONCEPTS = join(DOCS, "concepts/openapi-tools.mdx");
const MEMORY_CONCEPTS = join(DOCS, "concepts/memory.mdx");
const RUNTIME_EVENTS_REFERENCE = join(DOCS, "runtime/events.mdx");
const EVENT_TYPES_REFERENCE = join(DOCS, "reference/event-types.mdx");
const ENGINE_SOURCE = join(root, "packages/engine/src/engine.js");
const DB_PACKAGE_JSON = join(root, "packages/db/package.json");
const DB_RUN_STATE_SOURCE = join(root, "packages/db/src/runState.js");
const DB_RUN_STATE_TYPES = join(root, "packages/db/src/runState.d.ts");
const OPENAPI_HELPERS_SOURCE = join(root, "packages/openapi/src/tool-factory/_helpers.js");
const OPENAPI_LOAD_SPEC_EFFECT_SOURCE = join(root, "packages/openapi/src/loadSpecEffect.js");
const OPENAPI_LOAD_SPEC_SYNC_SOURCE = join(root, "packages/openapi/src/loadSpecSync.js");
const OPENAPI_SPEC_SOURCE = join(root, "packages/openapi/src/OpenApiSpec.ts");
const OPENAPI_DECLARATIONS = join(root, "packages/openapi/src/index.d.ts");
const GATEWAY_CLIENT_INDEX = join(root, "packages/gateway-client/src/index.ts");
const GATEWAY_CLIENT_SOURCE = join(root, "packages/gateway-client/src/SmithersGatewayClient.ts");
const GATEWAY_CLIENT_RPC_TYPE_MAP = join(root, "packages/gateway-client/src/GatewayRpcTypeMap.ts");
const GATEWAY_RPC_INDEX = join(root, "packages/gateway/src/rpc/index.ts");
const GATEWAY_REACT_INDEX = join(root, "packages/gateway-react/src/index.ts");
const GATEWAY_REACT_ASYNC_STATE = join(root, "packages/gateway-react/src/GatewayAsyncState.ts");
const GATEWAY_REACT_USE_GATEWAY_RUN = join(root, "packages/gateway-react/src/useGatewayRun.ts");
const GATEWAY_REACT_USE_GATEWAY_RPC = join(root, "packages/gateway-react/src/useGatewayRpc.ts");
const GATEWAY_REACT_USE_GATEWAY_NODE_OUTPUT = join(root, "packages/gateway-react/src/useGatewayNodeOutput.ts");
const GATEWAY_OPTIONS_SOURCE = join(root, "packages/server/src/GatewayOptions.ts");
const GATEWAY_AUTH_CONFIG_SOURCE = join(root, "packages/server/src/GatewayAuthConfig.ts");
const GATEWAY_TOKEN_GRANT_SOURCE = join(root, "packages/server/src/GatewayTokenGrant.ts");
const DOCS_CONFIG = join(DOCS, "docs.json");
const GENERATE_LLMS_SCRIPT = join(root, "scripts/generate-llms.ts");
const MCP_INTEGRATION_EXAMPLE_README = join(root, "examples/mcp-integration/README.md");
const MCP_TOOLSET_INTEGRATION = join(DOCS, "integrations/mcp-toolset.mdx");
const AGENTS_PACKAGE_JSON = join(root, "packages/agents/package.json");
const MCP_CREATE_TOOLSET_SOURCE = join(root, "packages/agents/src/mcp/createMcpToolset.js");
const MCP_CREATE_TOOLSET_DECLARATION = join(root, "packages/agents/src/mcp/createMcpToolset.d.ts");
const MCP_SERVER_CONFIG_SOURCE = join(root, "packages/agents/src/mcp/McpServerConfig.ts");
const MCP_TOOLSET_SOURCE = join(root, "packages/agents/src/mcp/McpToolset.ts");
const MCP_TOOLSET_OPTIONS_SOURCE = join(root, "packages/agents/src/mcp/McpToolsetOptions.ts");
const SDK_AGENTS_INTEGRATION = join(DOCS, "integrations/sdk-agents.mdx");
const CLI_AGENTS_INTEGRATION = join(DOCS, "integrations/cli-agents.mdx");
const PI_INTEGRATION = join(DOCS, "integrations/pi-integration.mdx");
const CLI_AGENT_AVAILABILITY_TYPE = join(root, "apps/cli/src/AgentAvailability.ts");
const CLI_AGENT_DETECTION_SOURCE = join(root, "apps/cli/src/agent-detection.js");
const CLI_HIJACK_SOURCE = join(root, "apps/cli/src/hijack.js");
const NATIVE_HIJACK_ENGINE_SOURCE = join(root, "apps/cli/src/NativeHijackEngine.ts");
const AGENT_LIKE_SOURCE = join(root, "packages/agents/src/AgentLike.ts");
const AGENT_GENERATE_OPTIONS_SOURCE = join(root, "packages/agents/src/BaseCliAgent/AgentGenerateOptions.ts");
const AGENT_CAPABILITY_REGISTRY_SOURCE = join(root, "packages/agents/src/capability-registry/AgentCapabilityRegistry.ts");
const AGENT_TOOL_DESCRIPTOR_SOURCE = join(root, "packages/agents/src/capability-registry/AgentToolDescriptor.ts");
const BASE_CLI_AGENT_SOURCE = join(root, "packages/agents/src/BaseCliAgent/BaseCliAgent.js");
const BASE_CLI_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/BaseCliAgent/BaseCliAgentOptions.ts");
const CACHE_POLICY_SOURCE = join(root, "packages/scheduler/src/CachePolicy.ts");
const SDK_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/SdkAgentOptions.ts");
const ANTHROPIC_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/AnthropicAgentOptions.ts");
const OPENAI_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/OpenAIAgentOptions.ts");
const HERMES_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/HermesAgentOptions.ts");
const OPENAI_AGENT_SOURCE = join(root, "packages/agents/src/OpenAIAgent.js");
const HERMES_AGENT_SOURCE = join(root, "packages/agents/src/HermesAgent.js");
const PI_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/PiAgentOptions.ts");
const PI_EXTENSION_UI_REQUEST_SOURCE = join(root, "packages/agents/src/BaseCliAgent/PiExtensionUiRequest.ts");
const PI_EXTENSION_UI_RESPONSE_SOURCE = join(root, "packages/agents/src/BaseCliAgent/PiExtensionUiResponse.ts");
const PI_AGENT_SOURCE = join(root, "packages/agents/src/PiAgent.js");
const OPENCODE_AGENT_SOURCE = join(root, "packages/agents/src/OpenCodeAgent.ts");
const CLAUDE_CODE_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/ClaudeCodeAgentOptions.ts");
const CODEX_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/CodexAgentOptions.ts");
const KIMI_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/KimiAgentOptions.ts");
const AMP_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/AmpAgentOptions.ts");
const VIBE_AGENT_OPTIONS_SOURCE = join(root, "packages/agents/src/VibeAgentOptions.ts");
const MEMORY_TASK_CONFIG_SOURCE = join(root, "packages/memory/src/TaskMemoryConfig.ts");
const MEMORY_WORKING_CONFIG_SOURCE = join(root, "packages/memory/src/WorkingMemoryConfig.ts");
const MEMORY_SEMANTIC_RECALL_CONFIG_SOURCE = join(root, "packages/memory/src/SemanticRecallConfig.ts");
const MEMORY_MESSAGE_HISTORY_CONFIG_SOURCE = join(root, "packages/memory/src/MessageHistoryConfig.ts");
const MEMORY_SERVICE_API_SOURCE = join(root, "packages/memory/src/MemoryServiceApi.ts");
const MEMORY_PROCESSOR_SOURCE = join(root, "packages/memory/src/MemoryProcessor.ts");
const MEMORY_PROCESSOR_CONFIG_SOURCE = join(root, "packages/memory/src/MemoryProcessorConfig.ts");
const MEMORY_LAYER_CONFIG_SOURCE = join(root, "packages/memory/src/MemoryLayerConfig.ts");
const SCORER_TYPES_SOURCE = join(root, "packages/scorers/src/types.ts");
const SCORER_AGGREGATE_OPTIONS_SOURCE = join(root, "packages/scorers/src/AggregateOptions.ts");
const LLM_JUDGE_CONFIG_SOURCE = join(root, "packages/scorers/src/LlmJudgeConfig.ts");
const CREATE_SCORER_CONFIG_SOURCE = join(root, "packages/scorers/src/CreateScorerConfig.ts");
const SANDBOX_PROPS_SOURCE = join(root, "packages/components/src/components/SandboxProps.ts");
const SANDBOX_EGRESS_CONFIG_SOURCE = join(root, "packages/sandbox/src/SandboxEgressConfig.ts");
const SANDBOX_EGRESS_SOURCE = join(root, "packages/sandbox/src/egress.js");
const SANDBOX_EXECUTE_SOURCE = join(root, "packages/sandbox/src/execute.js");
const SANDBOX_PROCESS_RUNNER_SOURCE = join(root, "packages/sandbox/src/effect/process-runner.js");
const SANDBOX_EXECUTE_TEST = join(root, "packages/sandbox/tests/execute.test.js");
const SANDBOX_TRANSPORT_RUNNERS_TEST = join(root, "packages/sandbox/tests/transport-runners.test.js");
const RECIPES_DOC = join(DOCS, "recipes.mdx");
const PACKAGE_CONFIGURATION_REFERENCE = join(DOCS, "reference/package-configuration.mdx");
const VCS_HELPERS_REFERENCE = join(DOCS, "reference/vcs-helpers.mdx");
const VCS_PACKAGE_JSON = join(root, "packages/vcs/package.json");
const VCS_INDEX_SOURCE = join(root, "packages/vcs/src/index.js");
const VCS_JJ_SOURCE = join(root, "packages/vcs/src/jj.js");
const VCS_DECLARATIONS = join(root, "packages/vcs/src/index.d.ts");
const TIME_TRAVEL_PACKAGE_JSON = join(root, "packages/time-travel/package.json");
const TIME_TRAVEL_INDEX_SOURCE = join(root, "packages/time-travel/src/index.js");
const TIME_TRAVEL_DECLARATIONS = join(root, "packages/time-travel/src/index.d.ts");
const OBSERVABILITY_INDEX_SOURCE = join(root, "apps/observability/src/index.js");
const OBSERVABILITY_DECLARATIONS = join(root, "apps/observability/src/index.d.ts");
const ROOT_PACKAGE_JSON = join(root, "package.json");
const ROOT_TSCONFIG = join(root, "tsconfig.json");
const EXAMPLES_TSCONFIG = join(root, "examples/tsconfig.json");
const SMITHERS_TSCONFIG = join(root, ".smithers/tsconfig.json");
const ROOT_BUNFIG = join(root, "bunfig.toml");
const PI_PLUGIN_PACKAGE_JSON = join(root, "packages/pi-plugin/package.json");
const RUNTIME_REVERT_REFERENCE = join(DOCS, "runtime/revert.mdx");
const WATCH_AND_STEER_GUIDE = join(DOCS, "guide/watch-and-steer.mdx");
const HOT_RELOAD_GUIDE = join(DOCS, "guides/hot-reload.mdx");
const DRIVER_RUN_OPTIONS_SOURCE = join(root, "packages/driver/src/RunOptions.ts");
const DRIVER_DECLARATIONS = join(root, "packages/driver/src/index.d.ts");
const HOT_WORKFLOW_CONTROLLER_SOURCE = join(root, "packages/engine/src/hot/HotWorkflowController.js");
const ALERT_RUNTIME_SOURCE = join(root, "packages/engine/src/alert-runtime.js");
const SCHEDULER_WORKFLOW_OPTIONS_SOURCE = join(root, "packages/scheduler/src/SmithersWorkflowOptions.ts");
const CONTROL_PLANE_DECLARATIONS = join(root, "packages/control-plane/src/index.d.ts");
const SMITHERS_CONTROL_PLANE_SOURCE = join(root, "packages/smithers/src/control-plane.js");
const REFERENCE_GATEWAY_SOURCE = join(root, "deploy/reference/reference-gateway.mjs");
const REFERENCE_DOCKER_COMPOSE = join(root, "deploy/reference/docker-compose.yml");
const REFERENCE_SYSTEMD_ENV = join(root, "deploy/reference/systemd/smithers-gateway.env.example");
const REFERENCE_K8S_DEPLOYMENT = join(root, "deploy/reference/k8s/deployment.yaml");
const REFERENCE_K8S_CONFIGMAP = join(root, "deploy/reference/k8s/configmap.yaml");
const STUDIO_APP_PACKAGE_JSON = join(root, "apps/smithers-studio-2/package.json");
const STUDIO_APP_README = join(root, "apps/smithers-studio-2/README.md");
const STUDIO_RUNS_PARSE_SOURCE = join(root, "apps/smithers-studio-2/src/runs/parseRunPayloads.ts");
const SMITHERS_WORKER_SOURCE = join(root, "apps/smithers/src/worker.ts");
const SMITHERS_GATEWAY_CLIENT_WRAPPER_SOURCE = join(root, "apps/smithers/src/gateway/gatewayClient.ts");
const IRON_PROXY_EGRESS_SPEC = join(root, ".smithers/specs/iron-proxy-egress-seam.html");
const CLOUD_EXECUTION_SPEC = join(root, ".smithers/specs/cloud-execution-engineering.md");
const CLOUD_PRODUCT_SPEC = join(root, ".smithers/specs/cloud-execution-product.md");

let failed = false;

for (const script of ["normalize-bunx.ts", "normalize-placeholders.ts"]) {
  const r = spawnSync("bun", [join("scripts", script), "--check"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) failed = true;
}

// Em-dash check (house style: none allowed).
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".mdx") || name.endsWith(".md")) out.push(p);
  }
  return out;
}
const offenders = [];
// The root README follows the same house style, so gate it alongside docs/.
for (const f of [...walk(DOCS), README]) {
  if (readFileSync(f, "utf8").includes("—")) offenders.push(f.replace(root + "/", ""));
}
if (offenders.length) {
  failed = true;
  console.error(
    `\n✗ ${offenders.length} doc file(s) contain em-dashes (—), which house style forbids:\n` +
      offenders.map((o) => `    ${o}`).join("\n"),
  );
} else {
  console.log("✓ no em-dashes in docs");
}

function readErrorDefinitionCodes() {
  const source = readFileSync(ERROR_DEFINITIONS, "utf8");
  return [...source.matchAll(/^\s{4}([A-Z0-9_]+):\s*\{/gm)].map((match) => match[1]);
}

function checkErrorReferenceCodes(codes) {
  const docs = readFileSync(ERROR_REFERENCE, "utf8");
  const runtimeSection = docs.split("\n## HTTP API Errors\n")[0] ?? docs;
  const rows = [...runtimeSection.matchAll(/^\|\s+`([A-Z0-9_]+)`\s+\|/gm)]
    .map((match) => match[1])
    .filter((code) => codes.includes(code));
  const missing = codes.filter((code) => !rows.includes(code));
  const duplicates = [...new Set(rows.filter((code, index) => rows.indexOf(code) !== index))];
  if (missing.length || duplicates.length) {
    failed = true;
    console.error("\n✗ docs/reference/errors.mdx does not match smithersErrorDefinitions:");
    if (missing.length) console.error(`    missing: ${missing.join(", ")}`);
    if (duplicates.length) console.error(`    duplicate: ${duplicates.join(", ")}`);
  } else {
    console.log("✓ error reference lists each built-in code once");
  }
}

function checkKnownErrorCodeUnion(codes) {
  const docs = readFileSync(TYPES_REFERENCE, "utf8");
  const match = docs.match(/type KnownSmithersErrorCode =([\s\S]*?);/);
  const documented = match
    ? [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((codeMatch) => codeMatch[1])
    : [];
  const missing = codes.filter((code) => !documented.includes(code));
  const extra = documented.filter((code) => !codes.includes(code));
  if (!match || missing.length || extra.length) {
    failed = true;
    console.error("\n✗ docs/reference/types.mdx KnownSmithersErrorCode does not match smithersErrorDefinitions:");
    if (!match) console.error("    type KnownSmithersErrorCode block not found");
    if (missing.length) console.error(`    missing: ${missing.join(", ")}`);
    if (extra.length) console.error(`    extra: ${extra.join(", ")}`);
  } else {
    console.log("✓ KnownSmithersErrorCode docs match built-in codes");
  }
}

function requireContains(label, source, needles) {
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length) {
    failed = true;
    console.error(`\n✗ ${label} is missing expected public API text:`);
    console.error(missing.map((needle) => `    ${needle}`).join("\n"));
  } else {
    console.log(`✓ ${label} includes expected public API text`);
  }
}

function checkGatewayTypeDocs() {
  const docs = readFileSync(TYPES_REFERENCE, "utf8");
  const integration = readFileSync(GATEWAY_INTEGRATION, "utf8");
  const optionsSource = readFileSync(GATEWAY_OPTIONS_SOURCE, "utf8");
  const tokenGrantSource = readFileSync(GATEWAY_TOKEN_GRANT_SOURCE, "utf8");
  requireContains("gateway type docs", docs, [
    "type GatewayUiConfig =",
    "type GatewayOperatorUiConfig =",
    "type GatewayRegisterOptions =",
    "type GatewayWebhookConfig =",
    "operatorUi?: GatewayOperatorUiConfig | false;",
    "tokenId?: string;",
    "issuedAtMs?: number;",
    "expiresAtMs?: number;",
    "revokedAtMs?: number;",
  ]);
  requireContains("gateway option source", optionsSource, [
    "ui?: GatewayUiConfig;",
    "operatorUi?: GatewayOperatorUiConfig | false;",
  ]);
  requireContains("gateway token grant source", tokenGrantSource, [
    "tokenId?: string;",
    "issuedAtMs?: number;",
    "expiresAtMs?: number;",
    "revokedAtMs?: number;",
  ]);
  requireContains("gateway integration docs", integration, [
    "ui?: GatewayUiConfig;",
    "operatorUi?: GatewayOperatorUiConfig | false;",
    "type GatewayOperatorUiConfig =",
    "type GatewayUiConfig =",
    "type GatewayTokenGrant =",
    "tokens: Record<string, GatewayTokenGrant>;",
    "tokenId?: string;",
    "issuedAtMs?: number;",
    "expiresAtMs?: number;",
    "revokedAtMs?: number;",
  ]);
  const staleGatewayIntegration = [
    "tokens: Record<string, { role: string; scopes: string[]; userId?: string }>;",
  ].filter((needle) => integration.includes(needle));
  if (staleGatewayIntegration.length) {
    failed = true;
    console.error("\n✗ gateway integration docs include stale type text:");
    console.error(staleGatewayIntegration.map((needle) => `    ${needle}`).join("\n"));
  }
}

function checkFacadeDeclarations() {
  const declarations = readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8");
  requireContains("smithers facade declarations", declarations, [
    "type CreateSmithersOptions",
    "declare function createSmithersPostgres",
    "type GatewayUiConfig",
    "type GatewayOperatorUiConfig",
    "type GatewayRegisterOptions",
    "type GatewayWebhookConfig",
    "export { SmithersDb } from '@smithers-orchestrator/db/adapter';",
    "export { revertToAttempt } from '@smithers-orchestrator/time-travel/revert';",
    "export { timeTravel } from '@smithers-orchestrator/time-travel/timetravel';",
    "VibeAgent",
    "type VibeAgentOptions",
  ]);
}

function parseNamedExportList(list) {
  const names = [];
  for (const raw of list.split(",")) {
    let part = raw.trim().replace(/^type\s+/, "").trim();
    if (!part) continue;
    const aliasMatch = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
    const name = aliasMatch ? aliasMatch[1] : part.split(/\s+/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

function collectExportedNames(source) {
  const names = new Set();
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const match of cleaned.matchAll(/export\s*\{([^{}]*?)\}(?:\s*from\s*["'][^"']+["'])?/g)) {
    for (const name of parseNamedExportList(match[1])) names.add(name);
  }
  for (const match of cleaned.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of cleaned.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  return names;
}

function collectDocumentedSmithersImports() {
  const imports = new Map();
  const importPattern = /import\s*\{([^{}]*?)\}\s*from\s*["']smithers-orchestrator["']/g;
  for (const file of currentDocFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      for (const raw of match[1].split(",")) {
        let part = raw.trim();
        if (!part) continue;
        const isType = part.startsWith("type ");
        part = part.replace(/^type\s+/, "").trim();
        const name = part.split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const entry = imports.get(name) ?? { type: false, value: false, files: new Set() };
        if (isType) entry.type = true;
        else entry.value = true;
        entry.files.add(file);
        imports.set(name, entry);
      }
    }
  }
  return imports;
}

function currentDocFiles() {
  const changelogDir = join(DOCS, "changelogs");
  return [...walk(DOCS).filter((file) => !file.startsWith(`${changelogDir}/`)), README];
}

function collectDocumentedPackageImports() {
  const imports = new Map();
  const importPattern =
    /import\s+(?:type\s+)?\{([^{}]*?)\}\s*from\s*["']((?:smithers-orchestrator\/|@smithers-orchestrator\/)[^"']+)["']/g;
  for (const file of currentDocFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2];
      const isTypeImport = /import\s+type\s*\{/.test(match[0]);
      const entry = imports.get(specifier) ?? new Map();
      for (const raw of match[1].split(",")) {
        let part = raw.trim();
        if (!part) continue;
        const isType = isTypeImport || part.startsWith("type ");
        part = part.replace(/^type\s+/, "").trim();
        const name = part.split(/\s+as\s+/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const item = entry.get(name) ?? { type: false, value: false, files: new Set() };
        if (isType) item.type = true;
        else item.value = true;
        item.files.add(file);
        entry.set(name, item);
      }
      imports.set(specifier, entry);
    }
  }
  return imports;
}

function checkDocumentedPackageImportsResolve() {
  const documented = collectDocumentedPackageImports();
  const runtimePayload = [...documented]
    .map(([specifier, names]) => ({
      specifier,
      values: [...names]
        .filter(([, entry]) => entry.value)
        .map(([name, entry]) => ({ name, files: [...entry.files].map(displayPath) })),
    }))
    .filter((item) => item.values.length);
  const runtimeScript = `
const payload = ${JSON.stringify(runtimePayload)};
const problems = [];
for (const item of payload) {
  let mod;
  try {
    mod = await import(item.specifier);
  } catch (error) {
    problems.push(item.specifier + ": runtime import failed " + error.message);
    continue;
  }
  const keys = new Set(Object.keys(mod));
  for (const value of item.values) {
    if (!keys.has(value.name)) {
      problems.push(item.specifier + ": missing runtime export " + value.name + " (" + value.files.join(", ") + ")");
    }
  }
}
if (problems.length) {
  console.error(problems.join("\\n"));
  process.exit(1);
}
`;
  const runtimeCheck = spawnSync("bun", ["--eval", runtimeScript], { cwd: root, encoding: "utf8" });

  const typeLines = [];
  let bindingCounter = 0;
  let typeCounter = 0;
  for (const [specifier, names] of [...documented].sort()) {
    const checks = [];
    const specifiers = [...names].sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
      const localName = `__DocsPackageImport${bindingCounter++}`;
      if (entry.value) {
        checks.push(`void ${localName};`);
        return `${name} as ${localName}`;
      }
      checks.push(`type __DocsPackageImportType${typeCounter++} = ${localName};`);
      return `type ${name} as ${localName}`;
    });
    typeLines.push(`import { ${specifiers.join(", ")} } from ${JSON.stringify(specifier)};`);
    typeLines.push(...checks);
  }
  const typeSource = `${typeLines.join("\n")}\n`;
  const rootFile = join(root, ".docs-package-import-check.ts");
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    types: ["bun"],
  };
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === rootFile
      ? ts.createSourceFile(fileName, typeSource, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (fileName) => fileName === rootFile || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => (fileName === rootFile ? typeSource : ts.sys.readFile(fileName));
  const program = ts.createProgram([rootFile], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === rootFile);

  if (runtimeCheck.status !== 0 || diagnostics.length) {
    failed = true;
    console.error("\n✗ documented package imports must resolve at runtime and in TypeScript:");
    if (runtimeCheck.status !== 0) console.error(runtimeCheck.stderr.trim());
    if (diagnostics.length) {
      for (const diagnostic of diagnostics) {
        const pos = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        const where = pos ? `${pos.line + 1}:${pos.character + 1}` : "unknown";
        console.error(`    ${where} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      }
    }
  } else {
    console.log("✓ documented package imports resolve at runtime and in TypeScript");
  }
}

function checkDocumentedSmithersImportsMatchFacade() {
  const documented = collectDocumentedSmithersImports();
  const runtimeExports = collectExportedNames(readFileSync(SMITHERS_FACADE_SOURCE, "utf8"));
  const declarationExports = collectExportedNames(readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8"));
  const missingRuntime = [];
  const missingDeclarations = [];
  for (const [name, entry] of [...documented].sort()) {
    const files = [...entry.files].map(displayPath);
    if (entry.value && !runtimeExports.has(name)) missingRuntime.push([name, files]);
    if (!declarationExports.has(name)) missingDeclarations.push([name, files]);
  }
  if (missingRuntime.length || missingDeclarations.length) {
    failed = true;
    console.error("\n✗ documented smithers-orchestrator imports must match facade exports:");
    if (missingRuntime.length) {
      console.error(
        `    missing runtime exports: ${missingRuntime.map(([name, files]) => `${name} (${files.join(", ")})`).join("; ")}`,
      );
    }
    if (missingDeclarations.length) {
      console.error(
        `    missing declarations: ${missingDeclarations.map(([name, files]) => `${name} (${files.join(", ")})`).join("; ")}`,
      );
    }
  } else {
    console.log("✓ documented smithers-orchestrator imports match facade exports");
  }
}

function checkImplementedApisNotMarkedComingSoon() {
  const files = [
    "docs/components/sandbox.mdx",
    "docs/components/timer.mdx",
    "docs/reference/types.mdx",
  ];
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const line of source.split("\n")) {
      if (
        /coming soon/i.test(line) &&
        /(egress|SandboxEgressConfig|Durable suspend|Durable Suspend|timer wake|Gateway wake)/i.test(line)
      ) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  if (offenders.length) {
    failed = true;
    console.error("\n✗ implemented egress/timer APIs are still marked coming soon:");
    console.error(offenders.map((offender) => `    ${offender}`).join("\n"));
  } else {
    console.log("✓ implemented egress/timer APIs are not marked coming soon");
  }
}

function checkTimerDocsMatchWakeRuntime() {
  const files = new Map([
    [TIMER_COMPONENT_DOC, readFileSync(TIMER_COMPONENT_DOC, "utf8")],
    [SERVER_GATEWAY_SOURCE, readFileSync(SERVER_GATEWAY_SOURCE, "utf8")],
    [CLI_SUPERVISOR_SOURCE, readFileSync(CLI_SUPERVISOR_SOURCE, "utf8")],
  ]);
  const required = [
    [TIMER_COMPONENT_DOC, "The host wakes the run on its own when the fire time arrives."],
    [TIMER_COMPONENT_DOC, "A Gateway sweeps due timers on its scheduler tick"],
    [TIMER_COMPONENT_DOC, "`bunx smithers-orchestrator supervise` also scans `waiting-timer` runs"],
    [TIMER_COMPONENT_DOC, "Wake resolution is bounded by the Gateway tick or supervisor interval"],
    [SERVER_GATEWAY_SOURCE, "async processDueTimers()"],
    [SERVER_GATEWAY_SOURCE, 'adapter.listRuns(1_000, "waiting-timer")'],
    [SERVER_GATEWAY_SOURCE, 'triggeredBy: "timer:gateway"'],
    [SERVER_GATEWAY_SOURCE, "void this.processDueTimers();"],
    [CLI_SUPERVISOR_SOURCE, "function processTimerCandidateEffect(options, run, staleBeforeMs)"],
    [CLI_SUPERVISOR_SOURCE, '.listRunsEffect(500, "waiting-timer")'],
    [CLI_SUPERVISOR_SOURCE, "runHasDueTimerEffect(options, run.runId, pollStartedAtMs)"],
    [CLI_SUPERVISOR_SOURCE, 'expectedStatus: "waiting-timer"'],
    [CLI_SUPERVISOR_SOURCE, "spawnResumeDetached(workflowPath, run.runId"],
  ];
  const forbidden = [
    [TIMER_COMPONENT_DOC, "Automatic Gateway wake sweeps for due timers landed after"],
    [TIMER_COMPONENT_DOC, "host-restart wake guarantees require a build from `main`"],
    [TIMER_COMPONENT_DOC, "release newer than `0.23.0`"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Timer docs must describe current durable wake behavior:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Timer docs describe current Gateway and supervisor wake behavior");
  }
}

function checkIronProxySpecMatchesSandboxSeam() {
  const source = readFileSync(IRON_PROXY_EGRESS_SPEC, "utf8");
  const required = [
    "sandbox-owned egress seam",
    "SandboxEgressConfig",
    "packages/sandbox/src/SandboxEgressConfig.ts",
    "executeSandbox()",
    "request.egress",
    "Smithers core has no built-in iron-proxy provider shortcut.",
  ];
  const forbidden = [
    "EgressProvider",
    "packages/driver/src/egress",
    "provider.attach",
    "BaseCliAgent",
    "ProxyAgent",
    "global undici",
    "agentServiceSpec",
    "@smithers-orchestrator/iron-proxy",
    'provider: "iron-proxy"',
    'provider="iron-proxy"',
    'provider: "freestyle-vm"',
    'provider="freestyle-vm"',
  ];
  const missing = required.filter((needle) => !source.includes(needle));
  const stale = forbidden.filter((needle) => source.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ .smithers/specs/iron-proxy-egress-seam.html does not match the sandbox-owned egress implementation:");
    if (missing.length) console.error(`    missing: ${missing.join(", ")}`);
    if (stale.length) console.error(`    stale: ${stale.join(", ")}`);
  } else {
    console.log("✓ iron-proxy spec describes sandbox-owned egress, not harness-level proxy wiring");
  }
}

function displayPath(file) {
  return file.replace(root + "/", "");
}

function kebabRpcDocName(method) {
  return `${method.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}.mdx`;
}

function inlineCodeList(items) {
  const quoted = items.map((item) => `\`${item}\``);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

function readTypeLiteralFieldNames(file, typeName) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fields = null;
  function visit(node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName && ts.isTypeLiteralNode(node.type)) {
      fields = node.type.members
        .filter((member) => (ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name)
        .map((member) => member.name.getText(sf).replace(/^["']|["']$/g, ""));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!fields) {
    throw new Error(`Could not read type literal ${typeName} from ${displayPath(file)}`);
  }
  return fields;
}

function readDocsTypeBlock(source, typeName) {
  const idx = source.indexOf(`type ${typeName}`);
  if (idx < 0) return null;
  const start = source.indexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function readGatewayRpcDefinitionsFromSource() {
  const source = readFileSync(GATEWAY_RPC_INDEX, "utf8");
  const entries = [];
  let current;
  for (const line of source.split(/\r?\n/)) {
    const method = line.match(/method: "([^"]+)"/);
    if (method) current = { method: method[1] };
    if (!current) continue;

    const scope = line.match(/requiredScope: "([^"]+)"/);
    if (scope) current.scope = scope[1];

    const errors = line.match(/errors: \[([^\]]+)\]/);
    if (errors) current.errors = [...errors[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    if (current.method && current.scope && current.errors) {
      entries.push(current);
      current = undefined;
    }
  }
  return entries;
}

function readGatewayRpcErrorDefinitionsFromSource() {
  const source = readFileSync(GATEWAY_RPC_INDEX, "utf8");
  return [...source.matchAll(/^\s+([A-Za-z_]+): \{ version: SMITHERS_API_VERSION, code: "([^"]+)", httpStatus: (\d+),/gm)]
    .map((match) => ({
      key: match[1],
      code: match[2],
      httpStatus: Number(match[3]),
    }));
}

function checkFreestyleDocsMatchProviderSeam() {
  const files = new Map([
    [CLOUD_EXECUTION_SPEC, readFileSync(CLOUD_EXECUTION_SPEC, "utf8")],
    [CLOUD_PRODUCT_SPEC, readFileSync(CLOUD_PRODUCT_SPEC, "utf8")],
    [join(root, "docs/components/sandbox.mdx"), readFileSync(join(root, "docs/components/sandbox.mdx"), "utf8")],
    [
      join(root, "docs/examples/freestyle-sandbox-provider.mdx"),
      readFileSync(join(root, "docs/examples/freestyle-sandbox-provider.mdx"), "utf8"),
    ],
    [join(root, "examples/freestyle/README.md"), readFileSync(join(root, "examples/freestyle/README.md"), "utf8")],
  ]);
  const required = [
    [CLOUD_EXECUTION_SPEC, 'Do not add `"freestyle"` to `SandboxRuntime`.'],
    [CLOUD_EXECUTION_SPEC, "No public `--runtime freestyle` flag is added."],
    [CLOUD_PRODUCT_SPEC, "<Sandbox provider={freestyleProvider}>"],
    [join(root, "docs/components/sandbox.mdx"), "vm.fs.writeTextFile()"],
    [join(root, "docs/components/sandbox.mdx"), "https://www.freestyle.sh/docs/vms"],
    [join(root, "docs/examples/freestyle-sandbox-provider.mdx"), "vm.fs.writeTextFile()"],
    [join(root, "examples/freestyle/README.md"), "vm.fs.writeTextFile()"],
  ];
  const forbidden = [
    [CLOUD_EXECUTION_SPEC, "FreestyleSandboxExecutorLive"],
    [CLOUD_EXECUTION_SPEC, "smithers env:setup --freestyle"],
    [CLOUD_EXECUTION_SPEC, "smithers run workflow.tsx --runtime freestyle"],
    [CLOUD_EXECUTION_SPEC, "smithers fork workflow.tsx --run-id run-001 --frame 5 --runtime freestyle"],
    [CLOUD_PRODUCT_SPEC, "smithers env:setup --freestyle"],
    [CLOUD_PRODUCT_SPEC, "--runtime freestyle"],
    [join(root, "docs/components/sandbox.mdx"), "additionalFiles"],
    [join(root, "docs/components/sandbox.mdx"), "https://docs.freestyle.sh/v2/vms"],
    [join(root, "docs/examples/freestyle-sandbox-provider.mdx"), "additionalFiles"],
    [join(root, "examples/freestyle/README.md"), "additionalFiles"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Freestyle sandbox docs do not match the provider-object implementation:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Freestyle sandbox docs describe provider objects, not core runtime strings");
  }
}

function checkRunStateDocsMatchCurrentEmission() {
  const files = new Map([
    [join(root, "docs/runtime/run-state.mdx"), readFileSync(join(root, "docs/runtime/run-state.mdx"), "utf8")],
    [join(root, "docs/runtime/events.mdx"), readFileSync(join(root, "docs/runtime/events.mdx"), "utf8")],
    [join(root, "docs/reference/event-types.mdx"), readFileSync(join(root, "docs/reference/event-types.mdx"), "utf8")],
    [join(root, "docs/reference/types.mdx"), readFileSync(join(root, "docs/reference/types.mdx"), "utf8")],
    [DB_PACKAGE_JSON, readFileSync(DB_PACKAGE_JSON, "utf8")],
    [DB_RUN_STATE_SOURCE, readFileSync(DB_RUN_STATE_SOURCE, "utf8")],
    [DB_RUN_STATE_TYPES, readFileSync(DB_RUN_STATE_TYPES, "utf8")],
    [ROOT_TSCONFIG, readFileSync(ROOT_TSCONFIG, "utf8")],
    [EXAMPLES_TSCONFIG, readFileSync(EXAMPLES_TSCONFIG, "utf8")],
    [SMITHERS_TSCONFIG, readFileSync(SMITHERS_TSCONFIG, "utf8")],
  ]);
  const required = [
    [join(root, "docs/runtime/run-state.mdx"), 'import { computeRunState } from "@smithers-orchestrator/db/runState";'],
    [join(root, "docs/runtime/run-state.mdx"), 'import { deriveRunState } from "@smithers-orchestrator/db/runState";'],
    [join(root, "docs/runtime/run-state.mdx"), "RunStateChanged` is a typed/reserved event variant, but the current runtime"],
    [join(root, "docs/runtime/events.mdx"), "the current runtime does not emit it"],
    [join(root, "docs/reference/event-types.mdx"), "typed and categorized for forward compatibility, but the current runtime does not emit it"],
    [join(root, "docs/reference/types.mdx"), "`SmithersEvent` is the discriminated union understood by the runtime and"],
    [join(root, "docs/reference/types.mdx"), "Most variants are emitted by the runtime; reserved"],
    [DB_PACKAGE_JSON, '"./runState"'],
    [DB_PACKAGE_JSON, '"import": "./src/runState.js"'],
    [DB_RUN_STATE_SOURCE, 'export { computeRunState } from "./runState/computeRunState.js";'],
    [DB_RUN_STATE_SOURCE, 'export { deriveRunState } from "./runState/deriveRunState.js";'],
    [DB_RUN_STATE_TYPES, "export declare function computeRunState("],
    [DB_RUN_STATE_TYPES, "export declare function deriveRunState("],
    [ROOT_TSCONFIG, "./packages/db/src/runState.js"],
    [ROOT_TSCONFIG, "./packages/db/src/runState.d.ts"],
    [EXAMPLES_TSCONFIG, "../packages/db/src/runState.js"],
    [EXAMPLES_TSCONFIG, "../packages/db/src/runState.d.ts"],
    [SMITHERS_TSCONFIG, "../packages/db/src/runState.js"],
    [SMITHERS_TSCONFIG, "../packages/db/src/runState.d.ts"],
  ];
  const forbidden = [
    [join(root, "docs/runtime/run-state.mdx"), "emitted by the recovery state machine"],
    [join(root, "docs/runtime/run-state.mdx"), "Event stream: `RunStateChanged` event"],
    [join(root, "docs/runtime/events.mdx"), "every lifecycle event the runtime emits"],
    [join(root, "docs/reference/event-types.mdx"), "discriminated union emitted by the runtime"],
    [join(root, "docs/reference/types.mdx"), "every lifecycle event the runtime"],
    [ROOT_TSCONFIG, "runState-types.ts"],
    [EXAMPLES_TSCONFIG, "runState-types.ts"],
    [SMITHERS_TSCONFIG, "runState-types.ts"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ RunState docs overstate current RunStateChanged emission:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ RunState docs mark RunStateChanged as typed/reserved, not emitted");
  }
}

function checkRunStateDocsMatchDerivationContract() {
  const runStateDoc = join(root, "docs/runtime/run-state.mdx");
  const deriveSource = join(root, "packages/db/src/runState/deriveRunState.js");
  const computeFromRowSource = join(root, "packages/db/src/runState/computeRunStateFromRow.js");
  const runStateViewType = join(root, "packages/db/src/runState/RunStateView.ts");
  const deriveTest = join(root, "packages/db/tests/runState-deriveRunState.test.js");
  const files = new Map([
    [runStateDoc, readFileSync(runStateDoc, "utf8")],
    [deriveSource, readFileSync(deriveSource, "utf8")],
    [computeFromRowSource, readFileSync(computeFromRowSource, "utf8")],
    [runStateViewType, readFileSync(runStateViewType, "utf8")],
    [deriveTest, readFileSync(deriveTest, "utf8")],
  ]);
  const required = [
    [runStateDoc, "`ReasonBlocked` and `ReasonUnhealthy` are optional reason payloads"],
    [runStateDoc, "A `waiting-*` state can be returned without"],
    [runStateDoc, "Current `computeRunState` / `deriveRunState`"],
    [runStateDoc, "emits `approval`, `event`, and `timer` blocked reasons"],
    [runStateDoc, "view.blocked;     // present for waiting-* only when backing context is found"],
    [runStateDoc, "view.unhealthy;   // present for stale/orphaned heartbeat expiry"],
    [deriveSource, ': { ...base, state: "waiting-approval" };'],
    [deriveSource, ': { ...base, state: "waiting-timer" };'],
    [deriveSource, ': { ...base, state: "waiting-event" };'],
    [computeFromRowSource, "pendingApproval = await loadPendingApproval(adapter, run.runId);"],
    [computeFromRowSource, "pendingTimer = await loadPendingTimer(adapter, run.runId);"],
    [computeFromRowSource, "pendingEvent = await loadPendingEvent(adapter, run.runId);"],
    [runStateViewType, "blocked?: ReasonBlocked;"],
    [runStateViewType, "unhealthy?: ReasonUnhealthy;"],
    [deriveTest, "waiting-approval without context"],
    [deriveTest, "expect(view.blocked).toBeUndefined();"],
  ];
  const forbidden = [
    [runStateDoc, "Every non-terminal, non-`running` state carries a typed reason."],
    [runStateDoc, "`blocked` is set when `state` is one of the `waiting-*` values."],
    [runStateDoc, "`unhealthy` is set when `state` is `stale`, `orphaned`, or `recovering`."],
    [runStateDoc, 'view.blocked;     // present iff state is "waiting-*"'],
    [runStateDoc, 'view.unhealthy;   // present iff state is "stale" | "orphaned" | "recovering"'],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ RunState docs must describe optional reason payloads:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ RunState docs describe optional reason payloads");
  }
}

function checkGatewayRpcReferenceDocsMatchRegistry() {
  const definitions = readGatewayRpcDefinitionsFromSource();
  const expectedDocs = definitions.map((definition) => kebabRpcDocName(definition.method)).sort();
  const actualDocs = readdirSync(RPC_DOCS).filter((name) => name.endsWith(".mdx")).sort();
  const missingDocs = expectedDocs.filter((name) => !actualDocs.includes(name));
  const extraDocs = actualDocs.filter((name) => !expectedDocs.includes(name));
  const problems = [];

  if (definitions.length !== 19) {
    problems.push(`expected 19 Gateway RPC definitions, found ${definitions.length}`);
  }
  for (const name of missingDocs) problems.push(`missing docs/rpc/${name}`);
  for (const name of extraDocs) problems.push(`unexpected docs/rpc/${name}`);

  for (const definition of definitions) {
    const docPath = join(RPC_DOCS, kebabRpcDocName(definition.method));
    if (!existsSync(docPath)) continue;
    const source = readFileSync(docPath, "utf8");
    const expectedErrorSentence = `Errors are versioned as \`v1\` and include ${inlineCodeList(definition.errors)}.`;
    const required = [
      `title: ${definition.method}`,
      `- Method: \`${definition.method}\``,
      `- Scope: \`${definition.scope}\``,
      expectedErrorSentence,
    ];
    for (const needle of required) {
      if (!source.includes(needle)) {
        problems.push(`${displayPath(docPath)} missing ${needle}`);
      }
    }
  }

  if (problems.length) {
    failed = true;
    console.error("\n✗ Gateway RPC reference docs must match the registry method, scope, and error lists:");
    console.error(`    ${problems.join("\n    ")}`);
  } else {
    console.log("✓ Gateway RPC reference docs match registry methods, scopes, and errors");
  }
}

function checkGatewayRpcErrorTableMatchesRegistry() {
  const definitions = readGatewayRpcErrorDefinitionsFromSource();
  const source = readFileSync(GATEWAY_INTEGRATION, "utf8");
  const problems = [];

  if (definitions.length === 0) {
    problems.push("no Gateway RPC errors parsed from registry");
  }
  for (const definition of definitions) {
    if (definition.key !== definition.code) {
      problems.push(`registry key ${definition.key} does not match code ${definition.code}`);
    }
  }
  const required = [
    `errors[${definitions.length}]{code,http}:`,
    ...definitions.map((definition) => `${definition.code},${definition.httpStatus}`),
  ];
  for (const needle of required) {
    if (!source.includes(needle)) {
      problems.push(`${displayPath(GATEWAY_INTEGRATION)} missing ${needle}`);
    }
  }

  if (problems.length) {
    failed = true;
    console.error("\n✗ Gateway RPC error table must match the registry error codes and HTTP statuses:");
    console.error(`    ${problems.join("\n    ")}`);
  } else {
    console.log("✓ Gateway RPC error table matches registry error codes and HTTP statuses");
  }
}

function checkGatewayLegacyErrorAliasDocsMatchStatusMap() {
  const serverSource = join(root, "packages/server/src/gateway.js");
  const files = new Map([
    [serverSource, readFileSync(serverSource, "utf8")],
    [GATEWAY_INTEGRATION, readFileSync(GATEWAY_INTEGRATION, "utf8")],
  ]);
  const required = [
    [serverSource, 'case "INVALID_REQUEST":'],
    [serverSource, 'case "INVALID_INPUT":'],
    [serverSource, 'case "UNAUTHORIZED":'],
    [serverSource, 'case "FORBIDDEN":'],
    [serverSource, 'case "NOT_FOUND":'],
    [serverSource, 'case "METHOD_NOT_FOUND":'],
    [serverSource, 'case "PAYLOAD_TOO_LARGE":'],
    [serverSource, 'case "InvalidRunId":'],
    [serverSource, 'case "InvalidFrameNo":'],
    [serverSource, 'case "ConfirmationRequired":'],
    [GATEWAY_INTEGRATION, "legacyErrors[12]{code,meaning,http}:"],
    [GATEWAY_INTEGRATION, "INVALID_REQUEST,Invalid request,400"],
    [GATEWAY_INTEGRATION, "INVALID_INPUT,Invalid input,400"],
    [GATEWAY_INTEGRATION, "UNAUTHORIZED,Unauthorized,401"],
    [GATEWAY_INTEGRATION, "FORBIDDEN,Forbidden,403"],
    [GATEWAY_INTEGRATION, "NOT_FOUND,Not found,404"],
    [GATEWAY_INTEGRATION, "METHOD_NOT_FOUND,Unknown method,404"],
    [GATEWAY_INTEGRATION, "PAYLOAD_TOO_LARGE,Payload too large,413"],
    [GATEWAY_INTEGRATION, "InvalidRunId,Invalid run id,400"],
    [GATEWAY_INTEGRATION, "InvalidFrameNo,Invalid frame number,400"],
    [GATEWAY_INTEGRATION, "ConfirmationRequired,Confirmation required,400"],
  ];
  const forbidden = [
    [GATEWAY_INTEGRATION, "Some legacy DevTools aliases still surface older validation names"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Gateway legacy error alias docs must match server status mappings:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Gateway legacy error alias docs match server status mappings");
  }
}

function checkGatewayAuthDocsMatchRuntimeDefaults() {
  const serverSource = join(root, "packages/server/src/gateway.js");
  const files = new Map([
    [serverSource, readFileSync(serverSource, "utf8")],
    [GATEWAY_AUTH_CONFIG_SOURCE, readFileSync(GATEWAY_AUTH_CONFIG_SOURCE, "utf8")],
    [GATEWAY_INTEGRATION, readFileSync(GATEWAY_INTEGRATION, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
  ]);
  const required = [
    [GATEWAY_AUTH_CONFIG_SOURCE, "scopesClaim?: string;"],
    [GATEWAY_AUTH_CONFIG_SOURCE, "roleClaim?: string;"],
    [GATEWAY_AUTH_CONFIG_SOURCE, "userClaim?: string;"],
    [GATEWAY_AUTH_CONFIG_SOURCE, "clockSkewSeconds?: number;"],
    [serverSource, "const skew = Math.max(0, config.clockSkewSeconds ?? 60);"],
    [serverSource, 'verified.payload[this.auth.scopesClaim ?? "scope"]'],
    [serverSource, 'verified.payload[this.auth.roleClaim ?? "role"]'],
    [serverSource, 'verified.payload[this.auth.userClaim ?? "sub"]'],
    [serverSource, 'scopes: scopes.length > 0 ? scopes : [...(this.auth.defaultScopes ?? [])],'],
    [serverSource, 'const [userHeader = "x-user-id", scopesHeader = "x-user-scopes", roleHeader = "x-user-role"]'],
    [serverSource, 'const role = asString(req.headers[roleHeader]) ?? this.auth.defaultRole ?? "operator";'],
    [serverSource, ': [...(this.auth.defaultScopes ?? ["*"])];'],
    [serverSource, "const allowedOrigins = this.auth.allowedOrigins ?? [];"],
    [GATEWAY_INTEGRATION, 'scopesClaim?: string;          // default "scope"'],
    [GATEWAY_INTEGRATION, 'roleClaim?: string;            // default "role"'],
    [GATEWAY_INTEGRATION, 'userClaim?: string;            // default "sub"'],
    [GATEWAY_INTEGRATION, 'defaultRole?: string;          // default "operator"'],
    [GATEWAY_INTEGRATION, "defaultScopes?: string[];      // default [] when scope claim is absent"],
    [GATEWAY_INTEGRATION, "clockSkewSeconds?: number;     // default 60; negative values clamp to 0"],
    [GATEWAY_INTEGRATION, "allowedOrigins?: string[];     // default [] (no Origin allowlist)"],
    [GATEWAY_INTEGRATION, 'trustedHeaders?: string[];     // default ["x-user-id","x-user-scopes","x-user-role"]'],
    [GATEWAY_INTEGRATION, 'defaultScopes?: string[];      // default ["*"] when scopes header is absent'],
    [
      GATEWAY_INTEGRATION,
      'JWT auth reads scopes from `scope`, role from `role`, and user id from `sub` unless the `*Claim` options override those claim names.',
    ],
    [
      GATEWAY_INTEGRATION,
      'Trusted-proxy auth reads `trustedHeaders` as `[user, scopes, role]`; missing role falls back to `defaultRole` and then `operator`, and missing scopes fall back to `defaultScopes` and then `["*"]`.',
    ],
    [TYPES_REFERENCE, 'scopesClaim?: string;          // default "scope"'],
    [TYPES_REFERENCE, 'roleClaim?: string;            // default "role"'],
    [TYPES_REFERENCE, 'userClaim?: string;            // default "sub"'],
    [TYPES_REFERENCE, 'defaultRole?: string;          // default "operator"'],
    [TYPES_REFERENCE, "defaultScopes?: string[];      // default [] when scope claim is absent"],
    [TYPES_REFERENCE, "clockSkewSeconds?: number;     // default 60; negative values clamp to 0"],
    [TYPES_REFERENCE, 'trustedHeaders?: string[];     // default ["x-user-id","x-user-scopes","x-user-role"]'],
    [TYPES_REFERENCE, "allowedOrigins?: string[];     // default [] (no Origin allowlist)"],
    [TYPES_REFERENCE, 'defaultScopes?: string[];      // default ["*"] when scopes header is absent'],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  if (missing.length) {
    failed = true;
    console.error("\n✗ Gateway auth docs must match runtime default claim, header, role, scope, and skew behavior:");
    console.error(`    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`);
  } else {
    console.log("✓ Gateway auth docs match runtime default claim, header, role, scope, and skew behavior");
  }
}

function checkGatewayGetRunDocsMatchResponseShape() {
  const files = new Map([
    [join(root, "packages/gateway/src/rpc/index.ts"), readFileSync(join(root, "packages/gateway/src/rpc/index.ts"), "utf8")],
    [join(root, "docs/rpc/get-run.mdx"), readFileSync(join(root, "docs/rpc/get-run.mdx"), "utf8")],
    [join(root, "docs/integrations/gateway.mdx"), readFileSync(join(root, "docs/integrations/gateway.mdx"), "utf8")],
    [join(root, "docs/guides/custom-workflow-ui.mdx"), readFileSync(join(root, "docs/guides/custom-workflow-ui.mdx"), "utf8")],
    [join(root, "docs/examples/workflow-ui-react.mdx"), readFileSync(join(root, "docs/examples/workflow-ui-react.mdx"), "utf8")],
  ]);
  const required = [
    [join(root, "packages/gateway/src/rpc/index.ts"), "Fetch one run record with node-state counts and optional derived runState."],
    [join(root, "packages/gateway/src/rpc/index.ts"), "responseSchema: runRecord"],
    [join(root, "docs/rpc/get-run.mdx"), "Response: run record with `summary` and optional `runState: RunStateView`"],
    [join(root, "docs/integrations/gateway.mdx"), "getRun,runId,Run record + optional runState"],
    [join(root, "docs/guides/custom-workflow-ui.mdx"), "{ data: Record<string, unknown>, loading, error, refetch }"],
    [join(root, "docs/examples/workflow-ui-react.mdx"), "type RunRecord = { status?: string; workflowKey?: string; runState?: RunStateView };"],
    [join(root, "docs/examples/workflow-ui-react.mdx"), "runRecord?.runState?.state ?? runRecord?.status"],
  ];
  const forbidden = [
    [join(root, "packages/gateway/src/rpc/index.ts"), "Fetch the current RunStateView for one run."],
    [join(root, "packages/gateway/src/rpc/index.ts"), 'responseSchema: objectSchema({}, [], "RunStateView.", true)'],
    [join(root, "docs/rpc/get-run.mdx"), "Response: `RunStateView`"],
    [join(root, "docs/integrations/gateway.mdx"), "getRun,runId,RunStateView,"],
    [join(root, "docs/guides/custom-workflow-ui.mdx"), "RunStateView, refetches as the seq advances"],
    [join(root, "docs/guides/custom-workflow-ui.mdx"), "{ data: RunStateView, loading, error, refetch }"],
    [join(root, "docs/examples/workflow-ui-react.mdx"), "const runState = run.data as RunStateView | undefined;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Gateway getRun docs must describe the run record payload, not a bare RunStateView:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Gateway getRun docs describe a run record with optional runState");
  }
}

function checkGatewayStreamDevToolsDocsMatchRuntimeShape() {
  const files = new Map([
    [GATEWAY_RPC_INDEX, readFileSync(GATEWAY_RPC_INDEX, "utf8")],
    [join(root, "packages/server/src/gateway.js"), readFileSync(join(root, "packages/server/src/gateway.js"), "utf8")],
    [join(root, "docs/rpc/stream-dev-tools.mdx"), readFileSync(join(root, "docs/rpc/stream-dev-tools.mdx"), "utf8")],
    [GATEWAY_INTEGRATION, readFileSync(GATEWAY_INTEGRATION, "utf8")],
  ]);
  const required = [
    [GATEWAY_RPC_INDEX, "export type StreamDevToolsRequest = {\n  runId: string;\n  afterSeq?: number;\n  fromSeq?: number;\n};"],
    [GATEWAY_RPC_INDEX, "requestSchema: objectSchema({ runId, afterSeq, fromSeq }, [\"runId\"]),"],
    [GATEWAY_RPC_INDEX, "exampleResponse: { streamId: \"stream_01\", runId: \"run_01\", fromSeq: 10, afterSeq: 10 },"],
    [join(root, "packages/server/src/gateway.js"), "fromSeq: typeof fromSeq === \"number\" ? fromSeq : null,\n                        afterSeq: typeof fromSeq === \"number\" ? fromSeq : null,"],
    [join(root, "docs/rpc/stream-dev-tools.mdx"), "- Request: `{ runId, afterSeq?, fromSeq? }`"],
    [join(root, "docs/rpc/stream-dev-tools.mdx"), "- Response: `{ streamId, runId, fromSeq, afterSeq }`"],
    [join(root, "docs/rpc/stream-dev-tools.mdx"), "If both are provided, they must match."],
    [GATEWAY_INTEGRATION, "streamDevTools,runId/afterSeq?/fromSeq?,{streamId/runId/fromSeq/afterSeq} + devtools.event frames,observability:read,websocket"],
  ];
  const forbidden = [
    [join(root, "docs/rpc/stream-dev-tools.mdx"), "- Request: `{ runId, afterSeq? }`"],
    [join(root, "docs/rpc/stream-dev-tools.mdx"), "- Response: `{ streamId, runId, afterSeq }`"],
    [GATEWAY_INTEGRATION, "streamDevTools,runId/afterSeq?,{streamId/runId/afterSeq} + devtools.event frames,observability:read,websocket"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ streamDevTools docs must match the runtime fromSeq/afterSeq wire shape:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ streamDevTools docs match runtime fromSeq/afterSeq wire shape");
  }
}

function checkGatewayCancelRunDocsMatchRuntimeErrors() {
  const serverSource = join(root, "packages/server/src/gateway.js");
  const cancelRunDoc = join(root, "docs/rpc/cancel-run.mdx");
  const files = new Map([
    [GATEWAY_RPC_INDEX, readFileSync(GATEWAY_RPC_INDEX, "utf8")],
    [serverSource, readFileSync(serverSource, "utf8")],
    [cancelRunDoc, readFileSync(cancelRunDoc, "utf8")],
    [GATEWAY_INTEGRATION, readFileSync(GATEWAY_INTEGRATION, "utf8")],
  ]);
  const required = [
    [serverSource, 'return responseError(frame.id, "RUN_NOT_ACTIVE", "Run is not currently active");'],
    [GATEWAY_RPC_INDEX, '| "RUN_NOT_ACTIVE"'],
    [GATEWAY_RPC_INDEX, 'RUN_NOT_ACTIVE: { version: SMITHERS_API_VERSION, code: "RUN_NOT_ACTIVE", httpStatus: 409'],
    [GATEWAY_RPC_INDEX, 'errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RUN_NOT_ACTIVE", "Internal"],'],
    [cancelRunDoc, "include `InvalidRequest`, `Unauthorized`, `Forbidden`, `RUN_NOT_ACTIVE`, and `Internal`"],
    [cancelRunDoc, "`RUN_NOT_ACTIVE` means the run is not currently active"],
    [GATEWAY_INTEGRATION, "RUN_NOT_ACTIVE,409"],
  ];
  const forbidden = [
    [GATEWAY_RPC_INDEX, 'errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "Busy", "Internal"],'],
    [cancelRunDoc, "`RunNotFound`, `Busy`"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ cancelRun docs must match runtime RUN_NOT_ACTIVE behavior:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ cancelRun docs match runtime RUN_NOT_ACTIVE behavior");
  }
}

function checkGatewaySubmitApprovalDocsMatchRuntimeErrors() {
  const approvalSource = join(root, "packages/engine/src/approvals.js");
  const submitApprovalDoc = join(root, "docs/rpc/submit-approval.mdx");
  const files = new Map([
    [GATEWAY_RPC_INDEX, readFileSync(GATEWAY_RPC_INDEX, "utf8")],
    [approvalSource, readFileSync(approvalSource, "utf8")],
    [submitApprovalDoc, readFileSync(submitApprovalDoc, "utf8")],
  ]);
  const required = [
    [approvalSource, 'new SmithersError("INVALID_INPUT", `Node ${nodeId} is not waiting for approval.`'],
    [GATEWAY_RPC_INDEX, 'errors: ["InvalidRequest", "InvalidInput", "Unauthorized", "Forbidden", "RunNotFound", "AlreadyDecided", "Internal"],'],
    [submitApprovalDoc, "include `InvalidRequest`, `InvalidInput`, `Unauthorized`, `Forbidden`, `RunNotFound`, `AlreadyDecided`, and `Internal`"],
  ];
  const forbidden = [
    [GATEWAY_RPC_INDEX, 'errors: ["InvalidRequest", "Unauthorized", "Forbidden", "RunNotFound", "NodeNotFound", "AlreadyDecided", "Internal"],'],
    [submitApprovalDoc, "`NodeNotFound`, `AlreadyDecided`"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ submitApproval docs must match runtime approval validation errors:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ submitApproval docs match runtime approval validation errors");
  }
}

function checkHotReloadDocsMatchRuntimeDefaults() {
  const files = new Map([
    [DRIVER_RUN_OPTIONS_SOURCE, readFileSync(DRIVER_RUN_OPTIONS_SOURCE, "utf8")],
    [DRIVER_DECLARATIONS, readFileSync(DRIVER_DECLARATIONS, "utf8")],
    [HOT_WORKFLOW_CONTROLLER_SOURCE, readFileSync(HOT_WORKFLOW_CONTROLLER_SOURCE, "utf8")],
    [HOT_RELOAD_GUIDE, readFileSync(HOT_RELOAD_GUIDE, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
  ]);
  const required = [
    [
      HOT_WORKFLOW_CONTROLLER_SOURCE,
      'this.outDir = opts?.outDir\n            ? resolve(opts.outDir)\n            : resolve(this.hotRoot, ".smithers", "hmr");',
    ],
    [DRIVER_RUN_OPTIONS_SOURCE, "Directory for generation overlays (default: rootDir/.smithers/hmr)"],
    [DRIVER_DECLARATIONS, "Directory for generation overlays (default: rootDir/.smithers/hmr)"],
    [TYPES_REFERENCE, "outDir?: string;                  // default .smithers/hmr under rootDir"],
    [
      HOT_RELOAD_GUIDE,
      "`outDir` (default `.smithers/hmr` under `rootDir` or the workflow entry directory)",
    ],
  ];
  const forbidden = [
    [DRIVER_RUN_OPTIONS_SOURCE, ".smithers/hmr/<runId>"],
    [DRIVER_DECLARATIONS, ".smithers/hmr/<runId>"],
    [TYPES_REFERENCE, ".smithers/hmr/<runId>"],
    [HOT_RELOAD_GUIDE, "`outDir` (default `.smithers/hmr`)"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ hot reload docs must match runtime default output directory:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ hot reload docs match runtime default output directory");
  }
}

function extractTypeProperties(source, typePattern) {
  const match = source.match(typePattern);
  if (!match?.[1]) return null;
  const properties = [];
  let depth = 0;
  for (const line of match[1].split("\n")) {
    if (depth === 0) {
      const property = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:/);
      if (property?.[1]) properties.push(property[1]);
    }
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return properties;
}

function checkRunOptionsDocsMatchSourceType() {
  const source = readFileSync(DRIVER_RUN_OPTIONS_SOURCE, "utf8");
  const declarations = readFileSync(DRIVER_DECLARATIONS, "utf8");
  const docs = readFileSync(TYPES_REFERENCE, "utf8");

  const sourceProps = extractTypeProperties(source, /export type RunOptions = \{([\s\S]*?)\n\};/);
  const declarationProps = extractTypeProperties(declarations, /type RunOptions\$2 = \{([\s\S]*?)\n\};/);
  const docProps = extractTypeProperties(docs, /type RunOptions = \{([\s\S]*?)\n\};/);

  const problems = [];
  if (!sourceProps) problems.push("could not parse packages/driver/src/RunOptions.ts RunOptions");
  if (!declarationProps) problems.push("could not parse packages/driver/src/index.d.ts RunOptions");
  if (!docProps) problems.push("could not parse docs/reference/types.mdx RunOptions");

  if (sourceProps && declarationProps) {
    const missing = sourceProps.filter((prop) => !declarationProps.includes(prop));
    const extra = declarationProps.filter((prop) => !sourceProps.includes(prop));
    if (missing.length) problems.push(`driver declaration missing: ${missing.join(", ")}`);
    if (extra.length) problems.push(`driver declaration extra: ${extra.join(", ")}`);
  }
  if (sourceProps && docProps) {
    const missing = sourceProps.filter((prop) => !docProps.includes(prop));
    const extra = docProps.filter((prop) => !sourceProps.includes(prop));
    if (missing.length) problems.push(`types docs missing: ${missing.join(", ")}`);
    if (extra.length) problems.push(`types docs extra: ${extra.join(", ")}`);
  }

  if (problems.length) {
    failed = true;
    console.error("\n✗ RunOptions docs and declarations must match the source type:");
    console.error(problems.map((problem) => `    ${problem}`).join("\n"));
  } else {
    console.log("✓ RunOptions docs and declarations match the source type");
  }
}

function checkSmithersWorkflowDocsMatchSourceType() {
  const source = readFileSync(join(root, "packages/driver/src/WorkflowDefinition.ts"), "utf8");
  const docs = readFileSync(TYPES_REFERENCE, "utf8");

  const sourceProps = extractTypeProperties(source, /export type WorkflowDefinition<Schema = unknown> = \{([\s\S]*?)\n\};/);
  const docProps = extractTypeProperties(docs, /interface SmithersWorkflow<Schema = unknown> \{([\s\S]*?)\n\}/);

  const problems = [];
  if (!sourceProps) problems.push("could not parse packages/driver/src/WorkflowDefinition.ts WorkflowDefinition");
  if (!docProps) problems.push("could not parse docs/reference/types.mdx SmithersWorkflow");

  if (sourceProps && docProps) {
    const missing = sourceProps.filter((prop) => !docProps.includes(prop));
    const extra = docProps.filter((prop) => !sourceProps.includes(prop));
    if (missing.length) problems.push(`types docs missing: ${missing.join(", ")}`);
    if (extra.length) problems.push(`types docs extra: ${extra.join(", ")}`);
  }

  const required = [
    [TYPES_REFERENCE, 'readonly zodToKeyName?: Map<import("zod").ZodObject<import("zod").ZodRawShape>, string>;'],
  ];
  const missingRequired = required.filter(([file, needle]) => !readFileSync(file, "utf8").includes(needle));
  if (missingRequired.length) {
    problems.push(
      `missing exact field text: ${missingRequired.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
    );
  }

  if (problems.length) {
    failed = true;
    console.error("\n✗ SmithersWorkflow docs must match WorkflowDefinition:");
    console.error(problems.map((problem) => `    ${problem}`).join("\n"));
  } else {
    console.log("✓ SmithersWorkflow docs match WorkflowDefinition");
  }
}

function extractClassBody(source, className) {
  const classIndex = source.indexOf(`declare class ${className}`);
  if (classIndex < 0) return null;
  const openIndex = source.indexOf("{", classIndex);
  if (openIndex < 0) return null;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

function extractClassPublicMembers(source, className) {
  const body = extractClassBody(source, className);
  if (!body) return null;
  const properties = [];
  const methods = [];
  for (const line of body.split("\n")) {
    const property = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:/);
    if (property?.[1] && !property[1].startsWith("_")) properties.push(property[1]);
    const method = !property && line.match(/^\s*([A-Za-z_$][\w$]*)\b.*\(/);
    if (method?.[1] && method[1] !== "constructor" && !method[1].startsWith("_")) methods.push(method[1]);
  }
  return { properties, methods };
}

function checkSmithersCtxDocsMatchDriverDeclaration() {
  const declarations = readFileSync(DRIVER_DECLARATIONS, "utf8");
  const typesDocs = readFileSync(TYPES_REFERENCE, "utf8");
  const howDocs = readFileSync(HOW_IT_WORKS, "utf8");
  const declarationMembers = extractClassPublicMembers(declarations, "SmithersCtx");
  const docMembers = extractClassPublicMembers(typesDocs, "SmithersCtx");
  const docBody = extractClassBody(typesDocs, "SmithersCtx");
  const expectedProperties = ["runId", "iteration", "iterations", "input", "auth", "outputs"];
  const expectedMethods = [
    "output",
    "outputMaybe",
    "latest",
    "latestArray",
    "iterationCount",
    "resolveTableName",
    "resolveRow",
  ];
  const problems = [];
  if (!declarationMembers) problems.push("could not parse packages/driver/src/index.d.ts SmithersCtx");
  if (!docMembers) problems.push("could not parse docs/reference/types.mdx SmithersCtx");
  if (!docBody) problems.push("could not parse docs/reference/types.mdx SmithersCtx body");
  if (declarationMembers) {
    const missingDeclarationProps = expectedProperties.filter((name) => !declarationMembers.properties.includes(name));
    const missingDeclarationMethods = expectedMethods.filter((name) => !declarationMembers.methods.includes(name));
    if (missingDeclarationProps.length) problems.push(`driver declaration missing properties: ${missingDeclarationProps.join(", ")}`);
    if (missingDeclarationMethods.length) problems.push(`driver declaration missing methods: ${missingDeclarationMethods.join(", ")}`);
  }
  if (docMembers) {
    const missingDocProps = expectedProperties.filter((name) => !docMembers.properties.includes(name));
    const missingDocMethods = expectedMethods.filter((name) => !docMembers.methods.includes(name));
    if (missingDocProps.length) problems.push(`types docs missing properties: ${missingDocProps.join(", ")}`);
    if (missingDocMethods.length) problems.push(`types docs missing methods: ${missingDocMethods.join(", ")}`);
  }

  const required = [
    [TYPES_REFERENCE, "input: Schema extends { input: infer T } ? T : unknown;"],
    [TYPES_REFERENCE, "latestArray(value: unknown, schema: SafeParser): unknown[];"],
    [TYPES_REFERENCE, "resolveTableName(table: any): string;"],
    [TYPES_REFERENCE, "resolveRow(table: any, key: OutputKey): any | undefined;"],
    [TYPES_REFERENCE, "type FallbackTableName<Schema> = [keyof Schema & string] extends [never] ? string : never;"],
    [HOW_IT_WORKS, "`ctx.outputs(table)` / `ctx.outputs.<key>`"],
    [HOW_IT_WORKS, "`ctx.latestArray(value, schema)`"],
    [HOW_IT_WORKS, "`ctx.resolveTableName(table)` / `ctx.resolveRow(table, key)`"],
    [HOW_IT_WORKS, "`ctx.runId` / `ctx.iteration` / `ctx.iterations`"],
  ];
  const forbidden = [
    [TYPES_REFERENCE, "Schema extends { input: infer T } ? T : any"],
    [TYPES_REFERENCE, "latestArray(value: unknown, schema: any): unknown[];"],
    [TYPES_REFERENCE, "type OutputAccessor<Schema> = ((table: any) => any[]) & Record<string, any[]>;"],
    [HOW_IT_WORKS, "ctx.outputMaybe(schema, { nodeId })"],
    [HOW_IT_WORKS, "ctx.output(schema, { nodeId })"],
    [HOW_IT_WORKS, "ctx.latest(schema, nodeId)"],
  ];
  const fileText = new Map([
    [TYPES_REFERENCE, typesDocs],
    [HOW_IT_WORKS, howDocs],
  ]);
  const missing = required.filter(([file, needle]) => !fileText.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => fileText.get(file)?.includes(needle));
  if (missing.length) problems.push(`missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`);
  if (stale.length) problems.push(`stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`);
  if (docBody?.includes("readonly runId")) problems.push("SmithersCtx docs still mark runId readonly");

  if (problems.length) {
    failed = true;
    console.error("\n✗ SmithersCtx docs must match the driver declaration:");
    console.error(problems.map((problem) => `    ${problem}`).join("\n"));
  } else {
    console.log("✓ SmithersCtx docs match the driver declaration");
  }
}

function checkCreateSmithersPostgresDocsMatchFactory() {
  const files = new Map([
    [SMITHERS_CREATE_SOURCE, readFileSync(SMITHERS_CREATE_SOURCE, "utf8")],
    [SMITHERS_FACADE_DECLARATIONS, readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [PRODUCTION_HARDENING_GUIDE, readFileSync(PRODUCTION_HARDENING_GUIDE, "utf8")],
  ]);
  const required = [
    [SMITHERS_CREATE_SOURCE, "const client = new pg.Client(connectionString ? { connectionString } : opts?.connection);"],
    [SMITHERS_CREATE_SOURCE, "close: async () => {"],
    [SMITHERS_FACADE_DECLARATIONS, "connection?: object;"],
    [SMITHERS_FACADE_DECLARATIONS, "close: () => Promise<void>;"],
    [TYPES_REFERENCE, '{ provider?: "postgres"; connectionString?: string; connection?: object }'],
    [TYPES_REFERENCE, "Promise<CreateSmithersApi<Schemas> & { close: () => Promise<void> }>;"],
    [PRODUCTION_HARDENING_GUIDE, 'pass a node-postgres connection config with `{ provider: "postgres", connection }`'],
    [PRODUCTION_HARDENING_GUIDE, 'run an in-process PGlite with `{ provider: "pglite", dataDir }`'],
    [PRODUCTION_HARDENING_GUIDE, "returns the same `createSmithers` API plus a `close()` teardown"],
  ];
  const forbidden = [
    [
      PRODUCTION_HARDENING_GUIDE,
      'Point it at managed Postgres with `{ provider: "postgres", connectionString }`, or at an in-process PGlite',
    ],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ createSmithersPostgres docs must match the factory and declaration:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ createSmithersPostgres docs match the factory and declaration");
  }
}

function checkCreateSmithersApiDocsMatchSourceType() {
  const files = new Map([
    [SMITHERS_CREATE_API_SOURCE, readFileSync(SMITHERS_CREATE_API_SOURCE, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
  ]);
  const docsBlock = readDocsTypeBlock(files.get(TYPES_REFERENCE), "CreateSmithersApi") ?? "";
  const required = [
    [SMITHERS_CREATE_API_SOURCE, "type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<z.ZodRawShape>>;"],
    [SMITHERS_CREATE_API_SOURCE, "type RuntimeSchema<Schema> = Schema extends { input: infer Input }"],
    [SMITHERS_CREATE_API_SOURCE, "Approval: <Row>(props: ApprovalProps<Row, SchemaOutput<Schema>>) => React.ReactElement;"],
    [SMITHERS_CREATE_API_SOURCE, "props: TaskProps<Row, SchemaOutput<Schema>, D>,"],
    [SMITHERS_CREATE_API_SOURCE, "Worktree: typeof BaseWorktree;"],
    [SMITHERS_CREATE_API_SOURCE, "Timer: typeof BaseTimer;"],
    [SMITHERS_CREATE_API_SOURCE, "useCtx: () => SmithersCtx<RuntimeSchema<Schema>>;"],
    [SMITHERS_CREATE_API_SOURCE, "db: BunSQLiteDatabase<Record<string, unknown>>;"],
    [SMITHERS_CREATE_API_SOURCE, "outputs: { [K in keyof Schema]: Schema[K] };"],
    [TYPES_REFERENCE, "type SchemaOutput<Schema> = Extract<"],
    [TYPES_REFERENCE, "type RuntimeSchema<Schema> ="],
    [TYPES_REFERENCE, "Approval: <Row>(props: ApprovalProps<Row, SchemaOutput<Schema>>) => React.ReactElement;"],
    [TYPES_REFERENCE, "Task: <Row, D extends DepsSpec = {}>(props: TaskProps<Row, SchemaOutput<Schema>, D>) => React.ReactElement;"],
    [TYPES_REFERENCE, "Worktree: typeof Worktree;"],
    [TYPES_REFERENCE, "Timer: typeof Timer;"],
    [TYPES_REFERENCE, "useCtx: () => SmithersCtx<RuntimeSchema<Schema>>;"],
    [TYPES_REFERENCE, "db: import(\"drizzle-orm/bun-sqlite\").BunSQLiteDatabase<Record<string, unknown>>;"],
    [TYPES_REFERENCE, "outputs: { [K in keyof Schema]: Schema[K] };"],
  ];
  const forbidden = [
    [TYPES_REFERENCE, "type CreateSmithersApi<Schema = any>"],
    [TYPES_REFERENCE, "Approval: <Row>(props: ApprovalProps<Row>)"],
    [TYPES_REFERENCE, "Task: <Row, D extends DepsSpec = {}>(props: TaskProps<Row, any, D>)"],
    [TYPES_REFERENCE, "Worktree: any;"],
    [TYPES_REFERENCE, "Timer: (props: TimerProps) => React.ReactElement;"],
    [TYPES_REFERENCE, "useCtx: () => SmithersCtx<Schema>;"],
    [TYPES_REFERENCE, "db: any;"],
    [TYPES_REFERENCE, "tables: Record<string, any>;"],
    [TYPES_REFERENCE, "outputs: Record<string, any>;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([, needle]) => docsBlock.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ CreateSmithersApi docs must match the source type:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ CreateSmithersApi docs match the source type");
  }
}

function checkCreateExternalSmithersDocsMatchSourceTypes() {
  const files = new Map([
    [EXTERNAL_SMITHERS_CONFIG_SOURCE, readFileSync(EXTERNAL_SMITHERS_CONFIG_SOURCE, "utf8")],
    [SERIALIZED_CTX_SOURCE, readFileSync(SERIALIZED_CTX_SOURCE, "utf8")],
    [HOST_NODE_JSON_SOURCE, readFileSync(HOST_NODE_JSON_SOURCE, "utf8")],
    [SMITHERS_FACADE_DECLARATIONS, readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
  ]);
  const required = [
    [EXTERNAL_SMITHERS_CONFIG_SOURCE, "schemas: S;"],
    [EXTERNAL_SMITHERS_CONFIG_SOURCE, "agents: Record<string, AgentLike>;"],
    [EXTERNAL_SMITHERS_CONFIG_SOURCE, "buildFn: (ctx: SerializedCtx) => HostNodeJson;"],
    [EXTERNAL_SMITHERS_CONFIG_SOURCE, "dbPath?: string;"],
    [SERIALIZED_CTX_SOURCE, "iterations: Record<string, number>;"],
    [SERIALIZED_CTX_SOURCE, "outputs: OutputSnapshot;"],
    [HOST_NODE_JSON_SOURCE, 'kind: "element";'],
    [HOST_NODE_JSON_SOURCE, "rawProps: Record<string, any>;"],
    [SMITHERS_FACADE_DECLARATIONS, "declare function createExternalSmithers"],
    [SMITHERS_FACADE_DECLARATIONS, "cleanup: () => void;"],
    [TYPES_REFERENCE, "type SerializedCtx = {"],
    [TYPES_REFERENCE, "type OutputSnapshot<TFallback = unknown> = {"],
    [TYPES_REFERENCE, "type HostNodeJson ="],
    [TYPES_REFERENCE, "rawProps: Record<string, any>;"],
    [TYPES_REFERENCE, "type ExternalSmithersConfig<S extends Record<string, import(\"zod\").ZodObject<any>>> = {"],
    [TYPES_REFERENCE, "agents: Record<string, AgentLike>;"],
    [TYPES_REFERENCE, "buildFn: (ctx: SerializedCtx) => HostNodeJson;"],
    [TYPES_REFERENCE, "dbPath?: string;"],
    [TYPES_REFERENCE, "declare function createExternalSmithers"],
    [TYPES_REFERENCE, "): SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void };"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  if (missing.length) {
    failed = true;
    console.error("\n✗ createExternalSmithers docs must match source types:");
    console.error(
      `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
    );
  } else {
    console.log("✓ createExternalSmithers docs match source types");
  }
}

function checkAgentAndCacheDocsMatchSourceTypes() {
  const files = new Map([
    [AGENT_LIKE_SOURCE, readFileSync(AGENT_LIKE_SOURCE, "utf8")],
    [AGENT_GENERATE_OPTIONS_SOURCE, readFileSync(AGENT_GENERATE_OPTIONS_SOURCE, "utf8")],
    [AGENT_CAPABILITY_REGISTRY_SOURCE, readFileSync(AGENT_CAPABILITY_REGISTRY_SOURCE, "utf8")],
    [AGENT_TOOL_DESCRIPTOR_SOURCE, readFileSync(AGENT_TOOL_DESCRIPTOR_SOURCE, "utf8")],
    [CACHE_POLICY_SOURCE, readFileSync(CACHE_POLICY_SOURCE, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
  ]);
  const required = [
    [CACHE_POLICY_SOURCE, "export type CachePolicy<Ctx = unknown> = {"],
    [CACHE_POLICY_SOURCE, "[key: string]: unknown;"],
    [AGENT_LIKE_SOURCE, "tools?: Record<string, unknown>;"],
    [AGENT_LIKE_SOURCE, "capabilities?: AgentCapabilityRegistry;"],
    [AGENT_LIKE_SOURCE, "generate: (args?: AgentGenerateOptions) => Promise<unknown>;"],
    [AGENT_GENERATE_OPTIONS_SOURCE, "taskContext?: {"],
    [AGENT_GENERATE_OPTIONS_SOURCE, "[key: string]: unknown;"],
    [AGENT_CAPABILITY_REGISTRY_SOURCE, 'engine: "claude-code" | "codex" | "antigravity" | "gemini" | "kimi" | "pi" | "amp" | "forge" | "opencode" | "vibe";'],
    [AGENT_CAPABILITY_REGISTRY_SOURCE, "runtimeTools: Record<string, AgentToolDescriptor>;"],
    [AGENT_TOOL_DESCRIPTOR_SOURCE, 'source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";'],
    [TYPES_REFERENCE, "type CachePolicy<Ctx = unknown> = {"],
    [TYPES_REFERENCE, "[key: string]: unknown;"],
    [TYPES_REFERENCE, "type AgentToolDescriptor = {"],
    [TYPES_REFERENCE, 'source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";'],
    [TYPES_REFERENCE, "type AgentCapabilityRegistry = {"],
    [TYPES_REFERENCE, 'engine: "claude-code" | "codex" | "antigravity" | "gemini" | "kimi" | "pi" | "amp" | "forge" | "opencode" | "vibe";'],
    [TYPES_REFERENCE, "runtimeTools: Record<string, AgentToolDescriptor>;"],
    [TYPES_REFERENCE, "type AgentGenerateOptions = {"],
    [TYPES_REFERENCE, "taskContext?: {"],
    [TYPES_REFERENCE, "tools?: Record<string, unknown>;"],
    [TYPES_REFERENCE, "capabilities?: AgentCapabilityRegistry;"],
    [TYPES_REFERENCE, "generate: (args?: AgentGenerateOptions) => Promise<unknown>;"],
  ];
  const forbidden = [
    [TYPES_REFERENCE, "type CachePolicy<Ctx = any>"],
    [TYPES_REFERENCE, "tools?: Record<string, any>;"],
    [TYPES_REFERENCE, "capabilities?: any;"],
    [TYPES_REFERENCE, "generate: (args: any) => Promise<any>;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ AgentLike and CachePolicy docs must match source types:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ AgentLike and CachePolicy docs match source types");
  }
}

function checkAlertingDocsMatchRuntimeSurface() {
  const files = new Map([
    [ALERTING_GUIDE, readFileSync(ALERTING_GUIDE, "utf8")],
    [ALERT_RUNTIME_SOURCE, readFileSync(ALERT_RUNTIME_SOURCE, "utf8")],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, readFileSync(SCHEDULER_WORKFLOW_OPTIONS_SOURCE, "utf8")],
    [CLI_ENTRYPOINT, readFileSync(CLI_ENTRYPOINT, "utf8")],
  ]);
  const required = [
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, 'export type SmithersAlertSeverity = "info" | "warning" | "critical";'],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, '| "emit-only"'],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, '| "pause"'],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, '| "cancel"'],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, '| "open-approval"'],
    [SCHEDULER_WORKFLOW_OPTIONS_SOURCE, '| "deliver"'],
    [ALERT_RUNTIME_SOURCE, "start() { }"],
    [ALERT_RUNTIME_SOURCE, "stop() { }"],
    [CLI_ENTRYPOINT, "const alertsOptions = z.object({});"],
    [CLI_ENTRYPOINT, "await adapter.listAlerts(200, ["],
    [CLI_ENTRYPOINT, '"firing",'],
    [CLI_ENTRYPOINT, '"acknowledged",'],
    [CLI_ENTRYPOINT, '"silenced",'],
    [ALERTING_GUIDE, "`alertPolicy` is currently workflow metadata plus a durable alert storage model."],
    [ALERTING_GUIDE, "The core engine starts an `AlertRuntime` wrapper for configured policies"],
    [
      ALERTING_GUIDE,
      "it does not run built-in alert evaluators, poll approval age, execute delivery clients, or create pause/cancel/approval reactions automatically.",
    ],
    [ALERTING_GUIDE, "`list` returns active `firing`, `acknowledged`, and `silenced` alerts."],
    [ALERTING_GUIDE, "Use `--format json` when another process needs to consume the rows."],
  ];
  const forbidden = [
    [ALERTING_GUIDE, "In 0.16"],
    [ALERTING_GUIDE, "core engine does not run built-in alert evaluators"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Alerting docs must match current alert policy types, runtime, and CLI surface:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Alerting docs match current alert policy types, runtime, and CLI surface");
  }
}

function checkControlPlaneDocsMatchStoreApi() {
  const docs = readFileSync(CONTROL_PLANE_GUIDE, "utf8");
  const declarations = readFileSync(CONTROL_PLANE_DECLARATIONS, "utf8");
  const facade = readFileSync(SMITHERS_CONTROL_PLANE_SOURCE, "utf8");
  const classMatch = declarations.match(/declare class ControlPlaneStore \{([\s\S]*?)\n\}/);
  const methods = classMatch
    ? [...classMatch[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\(/gm)]
      .map((match) => match[1])
      .filter((name) => name !== "constructor")
    : [];
  const missingMethods = methods.filter((name) => !docs.includes(`\`${name}()\``));
  const required = [
    [SMITHERS_CONTROL_PLANE_SOURCE, 'export * from "@smithers-orchestrator/control-plane";'],
    [CONTROL_PLANE_DECLARATIONS, "declare function ensureControlPlaneTables(sqlite: ControlPlaneSqlite): void;"],
    [CONTROL_PLANE_GUIDE, 'import { ControlPlaneStore } from "smithers-orchestrator/control-plane";'],
    [CONTROL_PLANE_GUIDE, 'import { ControlPlaneStore } from "@smithers-orchestrator/control-plane";'],
    [CONTROL_PLANE_GUIDE, "Constructing `new ControlPlaneStore(sqlite)` calls `ensureControlPlaneTables(sqlite)`."],
    [CONTROL_PLANE_GUIDE, "`checkUsageLimit()` | Return the matching limit plus `usedQuantity`, `remainingQuantity`, and `exceeded`, or `null` when no limit is configured."],
    [CONTROL_PLANE_GUIDE, "{ usedQuantity, remainingQuantity, exceeded, limitQuantity, ...limitMetadata }"],
  ];
  const forbidden = [
    [CONTROL_PLANE_GUIDE, "{ ok: boolean, used: number, limit: number }"],
    [CONTROL_PLANE_GUIDE, "`checkUsageLimit()` | Check whether the project is within its quota."],
  ];
  const fileText = (file) => {
    if (file === CONTROL_PLANE_GUIDE) return docs;
    if (file === CONTROL_PLANE_DECLARATIONS) return declarations;
    if (file === SMITHERS_CONTROL_PLANE_SOURCE) return facade;
    return "";
  };
  const missing = required.filter(([file, needle]) => !fileText(file).includes(needle));
  const stale = forbidden.filter(([file, needle]) => fileText(file).includes(needle));
  if (!classMatch) {
    missing.push([CONTROL_PLANE_DECLARATIONS, "declare class ControlPlaneStore {"]);
  }
  if (missingMethods.length) {
    missing.push([CONTROL_PLANE_GUIDE, `documented ControlPlaneStore methods: ${missingMethods.join(", ")}`]);
  }
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Control-plane docs must match ControlPlaneStore declarations:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Control-plane docs match ControlPlaneStore declarations");
  }
}

function checkReferenceDeploymentDocsMatchFiles() {
  const files = new Map([
    [REFERENCE_DEPLOYMENT_GUIDE, readFileSync(REFERENCE_DEPLOYMENT_GUIDE, "utf8")],
    [REFERENCE_GATEWAY_SOURCE, readFileSync(REFERENCE_GATEWAY_SOURCE, "utf8")],
    [REFERENCE_DOCKER_COMPOSE, readFileSync(REFERENCE_DOCKER_COMPOSE, "utf8")],
    [REFERENCE_SYSTEMD_ENV, readFileSync(REFERENCE_SYSTEMD_ENV, "utf8")],
    [REFERENCE_K8S_DEPLOYMENT, readFileSync(REFERENCE_K8S_DEPLOYMENT, "utf8")],
    [REFERENCE_K8S_CONFIGMAP, readFileSync(REFERENCE_K8S_CONFIGMAP, "utf8")],
  ]);
  const docs = files.get(REFERENCE_DEPLOYMENT_GUIDE) ?? "";
  const envNames = [
    "PORT",
    "SMITHERS_DB_PATH",
    "SMITHERS_TOKEN_STORE",
    "SMITHERS_GATEWAY_MODULE",
    "SMITHERS_GATEWAY_HEARTBEAT_MS",
    "SMITHERS_GATEWAY_EVENT_WINDOW",
    "SMITHERS_GATEWAY_HEADERS_TIMEOUT_MS",
    "SMITHERS_GATEWAY_REQUEST_TIMEOUT_MS",
  ];
  const missingEnvRows = envNames.filter((name) => !docs.includes(`| \`${name}\` |`));
  const required = [
    [REFERENCE_GATEWAY_SOURCE, 'const tokenStore = process.env.SMITHERS_TOKEN_STORE ?? "/data/tokens.json";'],
    [REFERENCE_GATEWAY_SOURCE, "if (!existsSync(tokenStore)) {\n    return {};\n  }"],
    [REFERENCE_GATEWAY_SOURCE, "heartbeatMs: Number(process.env.SMITHERS_GATEWAY_HEARTBEAT_MS ?? 15_000),"],
    [REFERENCE_GATEWAY_SOURCE, "eventWindowSize: Number(process.env.SMITHERS_GATEWAY_EVENT_WINDOW ?? 10_000),"],
    [REFERENCE_GATEWAY_SOURCE, "headersTimeout: Number(process.env.SMITHERS_GATEWAY_HEADERS_TIMEOUT_MS ?? 30_000),"],
    [REFERENCE_GATEWAY_SOURCE, "requestTimeout: Number(process.env.SMITHERS_GATEWAY_REQUEST_TIMEOUT_MS ?? 60_000),"],
    [REFERENCE_DOCKER_COMPOSE, "SMITHERS_DB_PATH: /data/smithers.db"],
    [REFERENCE_SYSTEMD_ENV, "SMITHERS_DB_PATH=/var/lib/smithers/smithers.db"],
    [REFERENCE_K8S_DEPLOYMENT, "name: SMITHERS_DB_PATH"],
    [REFERENCE_K8S_CONFIGMAP, 'SMITHERS_GATEWAY_MODULE: "/workspace/gateway.mjs"'],
    [REFERENCE_DEPLOYMENT_GUIDE, "the Gateway starts with an empty in-memory token set and denies token auth until you mount or write a token store."],
    [REFERENCE_DEPLOYMENT_GUIDE, "| `SMITHERS_DB_PATH` | `/data/smithers.db` | SQLite database path made available to the gateway module for workflow storage. |"],
  ];
  const forbidden = [
    [REFERENCE_DEPLOYMENT_GUIDE, "the Gateway creates an empty store on startup"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  for (const envName of missingEnvRows) {
    missing.push([REFERENCE_DEPLOYMENT_GUIDE, `Gateway Environment row for ${envName}`]);
  }
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Reference deployment docs must match deploy/reference files:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Reference deployment docs match deploy/reference files");
  }
}

function checkSandboxDocsMatchProviderTypes() {
  const files = new Map([
    [join(root, "packages/components/src/components/SandboxProps.ts"), readFileSync(join(root, "packages/components/src/components/SandboxProps.ts"), "utf8")],
    [join(root, "packages/sandbox/src/ExecuteSandboxOptions.ts"), readFileSync(join(root, "packages/sandbox/src/ExecuteSandboxOptions.ts"), "utf8")],
    [join(root, "packages/sandbox/src/SandboxProvider.ts"), readFileSync(join(root, "packages/sandbox/src/SandboxProvider.ts"), "utf8")],
    [join(root, "docs/components/sandbox.mdx"), readFileSync(join(root, "docs/components/sandbox.mdx"), "utf8")],
    [join(root, "docs/reference/types.mdx"), readFileSync(join(root, "docs/reference/types.mdx"), "utf8")],
  ]);
  const required = [
    [join(root, "packages/components/src/components/SandboxProps.ts"), "provider?: unknown;"],
    [join(root, "packages/sandbox/src/ExecuteSandboxOptions.ts"), "provider?: SandboxProvider | string;"],
    [join(root, "packages/sandbox/src/ExecuteSandboxOptions.ts"), "parentWorkflow: SandboxWorkflow | undefined"],
    [join(root, "packages/sandbox/src/SandboxProvider.ts"), "executeChildWorkflow: ExecuteSandboxChildWorkflow;"],
    [join(root, "docs/components/sandbox.mdx"), "provider?: unknown; // runtime accepts a provider object or registered provider id"],
    [join(root, "docs/components/sandbox.mdx"), "The JSX prop is typed `unknown`; at execution time Smithers accepts a provider object directly"],
    [join(root, "docs/reference/types.mdx"), "provider?: unknown;              // runtime accepts a provider object or registered provider id"],
    [join(root, "docs/reference/types.mdx"), "type ExecuteSandboxChildWorkflow = ("],
    [join(root, "docs/reference/types.mdx"), "executeChildWorkflow: ExecuteSandboxChildWorkflow;"],
    [join(root, "docs/reference/types.mdx"), "diffBundle?: SandboxDiffBundleLike;"],
    [join(root, "docs/reference/types.mdx"), "type ExecuteSandboxOptions = {"],
    [join(root, "docs/reference/types.mdx"), "provider?: SandboxProvider | string;"],
  ];
  const forbidden = [
    [join(root, "docs/components/sandbox.mdx"), "provider?: SandboxProvider | string;"],
    [join(root, "docs/reference/types.mdx"), "provider?: SandboxProvider | string; // object, or an id registered with registerSandboxProvider()"],
    [join(root, "docs/reference/types.mdx"), "executeChildWorkflow: (args: unknown) => Promise<unknown>;"],
    [join(root, "docs/reference/types.mdx"), "diffBundle?: unknown;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Sandbox docs must distinguish JSX provider typing from executeSandbox provider typing:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Sandbox docs match JSX provider and executeSandbox provider types");
  }
}

function checkSandboxEgressDocsMatchRuntime() {
  const files = new Map([
    [SANDBOX_COMPONENT_DOC, readFileSync(SANDBOX_COMPONENT_DOC, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [SANDBOX_PROPS_SOURCE, readFileSync(SANDBOX_PROPS_SOURCE, "utf8")],
    [SANDBOX_EGRESS_CONFIG_SOURCE, readFileSync(SANDBOX_EGRESS_CONFIG_SOURCE, "utf8")],
    [SANDBOX_EGRESS_SOURCE, readFileSync(SANDBOX_EGRESS_SOURCE, "utf8")],
    [SANDBOX_EXECUTE_SOURCE, readFileSync(SANDBOX_EXECUTE_SOURCE, "utf8")],
    [SANDBOX_PROCESS_RUNNER_SOURCE, readFileSync(SANDBOX_PROCESS_RUNNER_SOURCE, "utf8")],
    [SANDBOX_EXECUTE_TEST, readFileSync(SANDBOX_EXECUTE_TEST, "utf8")],
    [SANDBOX_TRANSPORT_RUNNERS_TEST, readFileSync(SANDBOX_TRANSPORT_RUNNERS_TEST, "utf8")],
  ]);
  const required = [
    [SANDBOX_COMPONENT_DOC, "egress?: {"],
    [SANDBOX_COMPONENT_DOC, "Use `egress` when the sandbox itself should own outbound-network configuration."],
    [SANDBOX_COMPONENT_DOC, "Provider-backed sandboxes receive the normalized contract as `request.egress`"],
    [SANDBOX_COMPONENT_DOC, "Local transports merge the generated proxy environment into the sandbox handle environment"],
    [TYPES_REFERENCE, "type SandboxEgressConfig = {"],
    [TYPES_REFERENCE, "egress?: SandboxEgressConfig;"],
    [SANDBOX_PROPS_SOURCE, "egress?: SandboxEgressConfig;"],
    [SANDBOX_EGRESS_CONFIG_SOURCE, "export type SandboxEgressConfig = {"],
    [SANDBOX_EGRESS_SOURCE, "export function normalizeSandboxEgressConfig(value)"],
    [SANDBOX_EGRESS_SOURCE, "export function sandboxEgressEnv(value"],
    [SANDBOX_EGRESS_SOURCE, "export async function writeSandboxEgressFiles(value, requestBundlePath)"],
    [SANDBOX_EGRESS_SOURCE, "export function redactSandboxEgressConfig(value)"],
    [SANDBOX_EXECUTE_SOURCE, "const egress = normalizeSandboxEgressConfig(rawConfig.egress);"],
    [SANDBOX_EXECUTE_SOURCE, "await writeSandboxEgressFiles(egress, requestBundlePath);"],
    [SANDBOX_EXECUTE_SOURCE, "egress,"],
    [SANDBOX_PROCESS_RUNNER_SOURCE, "...sandboxEgressEnv(egress),"],
    [SANDBOX_PROCESS_RUNNER_SOURCE, "...(egress ? { egress } : {}),"],
    [SANDBOX_EXECUTE_TEST, "passes egress config into provider-backed sandboxes and redacts persisted values"],
    [SANDBOX_TRANSPORT_RUNNERS_TEST, "local sandbox handles merge egress proxy config into sandbox env"],
  ];
  const forbidden = [
    [SANDBOX_COMPONENT_DOC, "Added after 0.23.0"],
    [SANDBOX_COMPONENT_DOC, "Sandbox egress controls were added after `0.23.0`"],
    [SANDBOX_COMPONENT_DOC, "Use a build from `main` or a release newer than `0.23.0`"],
    [TYPES_REFERENCE, "Added after 0.23.0"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Sandbox egress docs must match the current runtime contract:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Sandbox egress docs match the current runtime contract");
  }
}

function checkServeDocsMatchServerTypes() {
  const files = new Map([
    [join(root, "packages/server/src/ServeOptions.ts"), readFileSync(join(root, "packages/server/src/ServeOptions.ts"), "utf8")],
    [join(root, "packages/smithers/src/index.js"), readFileSync(join(root, "packages/smithers/src/index.js"), "utf8")],
    [join(root, "packages/smithers/src/index.d.ts"), readFileSync(join(root, "packages/smithers/src/index.d.ts"), "utf8")],
    [join(root, "docs/reference/types.mdx"), readFileSync(join(root, "docs/reference/types.mdx"), "utf8")],
    [join(root, "docs/integrations/serve.mdx"), readFileSync(join(root, "docs/integrations/serve.mdx"), "utf8")],
  ]);
  const required = [
    [join(root, "packages/server/src/ServeOptions.ts"), "workflow: SmithersWorkflow<unknown>;"],
    [join(root, "packages/server/src/ServeOptions.ts"), "adapter: SmithersDb;"],
    [join(root, "packages/smithers/src/index.js"), 'export { SmithersDb } from "@smithers-orchestrator/db";'],
    [join(root, "packages/smithers/src/index.d.ts"), "export { SmithersDb } from '@smithers-orchestrator/db/adapter';"],
    [join(root, "docs/reference/types.mdx"), 'type SmithersDb = import("@smithers-orchestrator/db/adapter").SmithersDb;'],
    [join(root, "docs/reference/types.mdx"), "workflow: SmithersWorkflow<unknown>;"],
    [join(root, "docs/reference/types.mdx"), "adapter: SmithersDb;"],
    [join(root, "docs/integrations/serve.mdx"), 'import { SmithersDb, createServeApp } from "smithers-orchestrator";'],
    [join(root, "docs/integrations/serve.mdx"), "const adapter = new SmithersDb(workflow.db);"],
    [join(root, "docs/integrations/serve.mdx"), "workflow: SmithersWorkflow<unknown>;"],
    [join(root, "docs/integrations/serve.mdx"), "adapter: SmithersDb;"],
    [join(root, "docs/integrations/serve.mdx"), "Smithers DB adapter; e.g. new SmithersDb(workflow.db)"],
  ];
  const forbidden = [
    [join(root, "docs/reference/types.mdx"), "workflow: SmithersWorkflow<any>;"],
    [join(root, "docs/reference/types.mdx"), "adapter: any;"],
    [join(root, "docs/integrations/serve.mdx"), 'typically drizzle("./smithers.db")'],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ ServeOptions docs and facade declarations must match server types:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ ServeOptions docs and SmithersDb facade declaration match server types");
  }
}

function checkHttpServerDocsMatchRuntimeSurface() {
  const files = new Map([
    [SERVER_SOURCE, readFileSync(SERVER_SOURCE, "utf8")],
    [SERVER_INTEGRATION, readFileSync(SERVER_INTEGRATION, "utf8")],
  ]);
  const required = [
    [SERVER_SOURCE, 'url.pathname === "/metrics"'],
    [SERVER_SOURCE, 'method === "POST" && url.pathname === "/v1/runs"'],
    [SERVER_SOURCE, 'method === "GET" && url.pathname === "/v1/runs"'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/resume$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/cancel$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/events$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/frames$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/nodes\\/([^/]+)\\/approve$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/nodes\\/([^/]+)\\/deny$/'],
    [SERVER_SOURCE, '/^\\/v1\\/runs\\/([^/]+)\\/signals\\/([^/]+)$/'],
    [SERVER_SOURCE, 'url.pathname === "/v1/approval/list"'],
    [SERVER_SOURCE, 'url.pathname === "/v1/approvals"'],
    [SERVER_SOURCE, 'url.pathname === "/approval/list"'],
    [SERVER_SOURCE, 'url.pathname === "/approvals"'],
    [SERVER_SOURCE, '/^\\/signal\\/([^/]+)\\/([^/]+)$/'],
    [SERVER_SOURCE, 'throw new HttpError(400, "INVALID_JSON"'],
    [SERVER_SOURCE, 'throw new HttpError(413, "PAYLOAD_TOO_LARGE"'],
    [SERVER_SOURCE, 'throw new HttpError(400, "RUN_ID_REQUIRED"'],
    [SERVER_INTEGRATION, "routes[15]{method,path,purpose,auth}:"],
    [SERVER_INTEGRATION, "GET,/metrics,Prometheus exposition,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs,Start or resume a run,bearer"],
    [SERVER_INTEGRATION, "GET,/v1/runs,List runs (requires db),bearer"],
    [SERVER_INTEGRATION, "GET,/v1/runs/:runId,Run status and node summary,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs/:runId/resume,Resume paused or failed run,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs/:runId/cancel,Abort an active run,bearer"],
    [SERVER_INTEGRATION, "GET,/v1/runs/:runId/events,SSE event stream (?afterSeq=N),bearer"],
    [SERVER_INTEGRATION, "GET,/v1/runs/:runId/frames,List render frames,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs/:runId/nodes/:nodeId/approve,Approve a paused node,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs/:runId/nodes/:nodeId/deny,Deny a paused node,bearer"],
    [SERVER_INTEGRATION, "POST,/v1/runs/:runId/signals/:signalName,Deliver a named signal,bearer"],
    [SERVER_INTEGRATION, "GET,/v1/approvals,List pending approvals (requires db),bearer"],
    [SERVER_INTEGRATION, "GET,/v1/approval/list,Legacy alias for /v1/approvals,bearer"],
    [SERVER_INTEGRATION, "GET,/approval/list and /approvals,Legacy aliases for /v1/approvals,bearer"],
    [SERVER_INTEGRATION, "POST,/signal/:runId/:signalName,Legacy alias for signals,bearer"],
    [SERVER_INTEGRATION, "`INVALID_JSON`"],
    [SERVER_INTEGRATION, "`PAYLOAD_TOO_LARGE`"],
    [SERVER_INTEGRATION, "`RUN_ID_REQUIRED`"],
    [SERVER_INTEGRATION, 'import { bashTool } from "smithers-orchestrator/tools";'],
    [SERVER_INTEGRATION, 'await bashTool("echo", [ctx.input.msg])'],
  ];
  const forbidden = [
    [SERVER_INTEGRATION, 'createSmithers, bash } from "smithers-orchestrator"'],
    [SERVER_INTEGRATION, "await bash(`echo ${ctx.input.msg}`)"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ HTTP server docs must match runtime routes and error codes:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ HTTP server docs match runtime routes and error codes");
  }
}

function checkComponentPropsDocsMatchSourceTypes() {
  const files = new Map([
    [join(root, "packages/components/src/components/ApprovalAutoApprove.ts"), readFileSync(join(root, "packages/components/src/components/ApprovalAutoApprove.ts"), "utf8")],
    [join(root, "packages/components/src/components/ApprovalProps.ts"), readFileSync(join(root, "packages/components/src/components/ApprovalProps.ts"), "utf8")],
    [join(root, "packages/components/src/components/PollerProps.ts"), readFileSync(join(root, "packages/components/src/components/PollerProps.ts"), "utf8")],
    [join(root, "packages/components/src/components/DriftDetectorProps.ts"), readFileSync(join(root, "packages/components/src/components/DriftDetectorProps.ts"), "utf8")],
    [join(root, "packages/components/src/components/ColumnDef.ts"), readFileSync(join(root, "packages/components/src/components/ColumnDef.ts"), "utf8")],
    [join(root, "docs/reference/types.mdx"), readFileSync(join(root, "docs/reference/types.mdx"), "utf8")],
    [join(root, "docs/components/approval.mdx"), readFileSync(join(root, "docs/components/approval.mdx"), "utf8")],
    [join(root, "docs/components/poller.mdx"), readFileSync(join(root, "docs/components/poller.mdx"), "utf8")],
    [join(root, "docs/components/drift-detector.mdx"), readFileSync(join(root, "docs/components/drift-detector.mdx"), "utf8")],
  ]);
  const required = [
    [join(root, "packages/components/src/components/ApprovalAutoApprove.ts"), "SmithersCtx<unknown> | null"],
    [join(root, "packages/components/src/components/ApprovalProps.ts"), "key?: string;"],
    [join(root, "packages/components/src/components/ApprovalProps.ts"), "children?: React.ReactNode;"],
    [join(root, "packages/components/src/components/PollerProps.ts"), "check: AgentLike | (() => unknown | Promise<unknown>);"],
    [join(root, "packages/components/src/components/DriftDetectorProps.ts"), "intervalMs?: number;"],
    [join(root, "packages/components/src/components/ColumnDef.ts"), 'type ColumnTaskProps = Omit<Partial<TaskProps<unknown>>, "agent" | "children" | "id" | "key" | "output" | "smithersContext">;'],
    [join(root, "docs/reference/types.mdx"), "condition?: ((ctx: SmithersCtx<unknown> | null) => boolean) | (() => boolean);"],
    [join(root, "docs/reference/types.mdx"), "revertOn?: ((ctx: SmithersCtx<unknown> | null) => boolean) | (() => boolean);"],
    [join(root, "docs/reference/types.mdx"), "check: AgentLike | (() => unknown | Promise<unknown>);"],
    [join(root, "docs/reference/types.mdx"), 'type ColumnTaskProps = Omit<Partial<TaskProps<unknown>>, "agent" | "children" | "id" | "key" | "output" | "smithersContext">;'],
    [join(root, "docs/reference/types.mdx"), "task?: ColumnTaskProps;"],
    [join(root, "docs/components/approval.mdx"), "key?: string;"],
    [join(root, "docs/components/approval.mdx"), "children?: React.ReactNode;"],
    [join(root, "docs/components/poller.mdx"), "check: AgentLike | (() => Promise<unknown> | unknown);"],
    [join(root, "docs/components/drift-detector.mdx"), "poll?: { intervalMs?: number; maxPolls?: number };"],
  ];
  const forbidden = [
    [join(root, "docs/reference/types.mdx"), "condition?: ((ctx: any) => boolean) | (() => boolean);"],
    [join(root, "docs/reference/types.mdx"), "revertOn?: ((ctx: any) => boolean) | (() => boolean);"],
    [join(root, "docs/reference/types.mdx"), "check: AgentLike | ((...args: any[]) => any);"],
    [join(root, "docs/reference/types.mdx"), "task?: Partial<TaskProps<unknown>>;"],
    [join(root, "docs/components/approval.mdx"), "smithersContext"],
    [join(root, "docs/components/drift-detector.mdx"), "poll?: { intervalMs: number; maxPolls?: number };"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Component prop docs must match source prop declarations:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Component prop docs match source prop declarations");
  }
}

function checkTypesReferenceIncludesCompositeComponentProps() {
  const reference = readFileSync(TYPES_REFERENCE, "utf8");
  const trackedTypes = [
    ["ApprovalGateProps", join(root, "packages/components/src/components/ApprovalGateProps.ts")],
    ["HumanTaskProps", join(root, "packages/components/src/components/HumanTaskProps.ts")],
    ["CheckConfig", join(root, "packages/components/src/components/CheckConfig.ts")],
    ["CheckSuiteProps", join(root, "packages/components/src/components/CheckSuiteProps.ts")],
    ["TokenBudgetConfig", join(root, "packages/components/src/aspects/TokenBudgetConfig.ts")],
    ["LatencySloConfig", join(root, "packages/components/src/aspects/LatencySloConfig.ts")],
    ["TrackingConfig", join(root, "packages/components/src/aspects/TrackingConfig.ts")],
    ["AspectsProps", join(root, "packages/components/src/components/AspectsProps.ts")],
    ["CategoryConfig", join(root, "packages/components/src/components/CategoryConfig.ts")],
    ["ClassifyAndRouteProps", join(root, "packages/components/src/components/ClassifyAndRouteProps.ts")],
    ["SourceDef", join(root, "packages/components/src/components/SourceDef.ts")],
    ["GatherAndSynthesizeProps", join(root, "packages/components/src/components/GatherAndSynthesizeProps.ts")],
    ["ContentPipelineStage", join(root, "packages/components/src/components/ContentPipelineStage.ts")],
    ["ContentPipelineProps", join(root, "packages/components/src/components/ContentPipelineProps.ts")],
    ["DebateProps", join(root, "packages/components/src/components/DebateProps.ts")],
    ["DecisionRule", join(root, "packages/components/src/components/DecisionRule.ts")],
    ["DecisionTableProps", join(root, "packages/components/src/components/DecisionTableProps.ts")],
    ["DriftDetectorProps", join(root, "packages/components/src/components/DriftDetectorProps.ts")],
    ["EscalationLevel", join(root, "packages/components/src/components/EscalationLevel.ts")],
    ["EscalationChainProps", join(root, "packages/components/src/components/EscalationChainProps.ts")],
    ["MergeQueueProps", join(root, "packages/components/src/components/MergeQueueProps.ts")],
    ["OptimizerProps", join(root, "packages/components/src/components/OptimizerProps.ts")],
    ["PanelistConfig", join(root, "packages/components/src/components/PanelistConfig.ts")],
    ["PanelProps", join(root, "packages/components/src/components/PanelProps.ts")],
    ["ReviewLoopProps", join(root, "packages/components/src/components/ReviewLoopProps.ts")],
    ["RunbookStep", join(root, "packages/components/src/components/RunbookStep.ts")],
    ["RunbookProps", join(root, "packages/components/src/components/RunbookProps.ts")],
    ["ScanFixVerifyProps", join(root, "packages/components/src/components/ScanFixVerifyProps.ts")],
    ["SupervisorProps", join(root, "packages/components/src/components/SupervisorProps.ts")],
    ["ContinueAsNewProps", join(root, "packages/components/src/components/ContinueAsNewProps.ts")],
  ];
  const missing = [];
  for (const [typeName, file] of trackedTypes) {
    const block = readDocsTypeBlock(reference, typeName);
    if (!block) {
      missing.push([TYPES_REFERENCE, `type ${typeName}`]);
      continue;
    }
    for (const fieldName of readTypeLiteralFieldNames(file, typeName)) {
      if (!block.includes(fieldName)) {
        missing.push([TYPES_REFERENCE, `${typeName}.${fieldName}`]);
      }
    }
  }
  if (missing.length) {
    failed = true;
    console.error("\n✗ Types reference must include exported composite component prop types:");
    console.error(
      `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
    );
  } else {
    console.log("✓ Types reference includes exported composite component prop types");
  }
}

function readTomlScalar(source, key, section) {
  let sectionSource = source.split("\n[").at(0);
  if (section) {
    const sectionStart = source.indexOf(`[${section}]`);
    if (sectionStart === -1) return undefined;
    const afterSectionHeader = source.indexOf("\n", sectionStart) + 1;
    const nextSection = source.indexOf("\n[", afterSectionHeader);
    sectionSource = source.slice(afterSectionHeader, nextSection === -1 ? undefined : nextSection);
  }
  return sectionSource?.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim();
}

function readWorkspacePackages() {
  const packages = [];
  for (const dir of ["packages", "apps"]) {
    const fullDir = join(root, dir);
    for (const name of readdirSync(fullDir)) {
      const packageJsonPath = join(fullDir, name, "package.json");
      if (!existsSync(packageJsonPath)) continue;
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      packages.push({ name: packageJson.name, private: Boolean(packageJson.private) });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function readWorkspacePackageNames() {
  return readWorkspacePackages().map((pkg) => pkg.name);
}

function checkPackageConfigurationDocsMatchRootConfig() {
  const docs = readFileSync(PACKAGE_CONFIGURATION_REFERENCE, "utf8");
  const bunfig = readFileSync(ROOT_BUNFIG, "utf8");
  const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8"));
  const publicPackageJson = JSON.parse(readFileSync(SMITHERS_PACKAGE_JSON, "utf8"));
  const workspacePackages = readWorkspacePackages();
  const workspacePackageNames = workspacePackages.map((pkg) => pkg.name);
  const documentedWorkspacePackageNames = [...docs.matchAll(/^\| `(@smithers-orchestrator\/[^`]+|smithers-orchestrator)` \|/gm)]
    .map((match) => match[1])
    .sort();
  const missingWorkspacePackageRows = workspacePackageNames.filter((name) => !documentedWorkspacePackageNames.includes(name));
  const extraWorkspacePackageRows = documentedWorkspacePackageNames.filter((name) => !workspacePackageNames.includes(name));
  const rootWorkspaceDeps = new Set(
    Object.entries({
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
    })
      .filter(([, version]) => version === "workspace:*")
      .map(([name]) => name),
  );
  const missingRootWorkspaceDeps = workspacePackages
    .filter((pkg) => !pkg.private)
    .filter((pkg) => pkg.name === "smithers-orchestrator" || pkg.name.startsWith("@smithers-orchestrator/"))
    .filter((pkg) => !/^@smithers-orchestrator\/jj-/.test(pkg.name))
    .filter((pkg) => !rootWorkspaceDeps.has(pkg.name))
    .map((pkg) => pkg.name);
  const runtimePreload = readTomlScalar(bunfig, "preload");
  const testRoot = readTomlScalar(bunfig, "root", "test");
  const testPreload = readTomlScalar(bunfig, "preload", "test");
  const publicPackageName = publicPackageJson.name;
  const exportRows = Object.entries(publicPackageJson.exports ?? {}).map(([subpath, target]) => {
    const importPath = subpath === "." ? publicPackageName : `${publicPackageName}/${subpath.slice(2)}`;
    const entry = typeof target === "string"
      ? target
      : target.import ?? target.default ?? target.types;
    return `| \`${importPath}\` | \`${entry}\` |`;
  });
  const facadeSubpathRows = [
    ["smithers-orchestrator/gateway", "./src/gateway.js"],
    ["smithers-orchestrator/gateway-client", "./src/gateway-client.js"],
    ["smithers-orchestrator/gateway-react", "./src/gateway-react.js"],
    ["smithers-orchestrator/sandbox", "./src/sandbox.js"],
    ["smithers-orchestrator/jsx-runtime", "./src/jsx-runtime.js"],
    ["smithers-orchestrator/server", "./src/server.js"],
    ["smithers-orchestrator/observability", "./src/observability.js"],
    ["smithers-orchestrator/mdx-plugin", "./src/mdx-plugin.js"],
    ["smithers-orchestrator/dom/renderer", "./src/dom/renderer.js"],
    ["smithers-orchestrator/serve", "./src/serve.js"],
    ["smithers-orchestrator/scorers", "./src/scorers.js"],
    ["smithers-orchestrator/memory", "./src/memory.js"],
    ["smithers-orchestrator/openapi", "./src/openapi.js"],
  ];
  const missingFacadeWrapperFiles = facadeSubpathRows
    .map(([importPath, entry]) => ({ importPath, entry, file: join(root, "packages/smithers", entry.replace(/^\.\//, "")) }))
    .filter(({ file }) => !existsSync(file));
  const required = [
    runtimePreload ? `preload = ${runtimePreload}` : null,
    testRoot ? `root = ${testRoot}` : null,
    testPreload ? `preload = ${testPreload}` : null,
    testRoot ? `| \`root\` | \`${testRoot.replace(/^"|"$/g, "")}\` |` : null,
    testPreload ? `| \`preload\` | \`${testPreload}\` |` : null,
    "Entry files in this table are relative to the published `smithers-orchestrator` package; in the repository they live under `packages/smithers/`.",
    "Most applications should import from `smithers-orchestrator`. The workspace packages below are listed for advanced integrations, custom clients, framework development, and monorepo orientation. Some app workspaces are private and are not published packages.",
    ...exportRows,
    ...facadeSubpathRows.map(([importPath, entry]) => `| \`${importPath}\` | \`${entry}\` |`),
    ...Object.entries(packageJson.scripts ?? {}).map(([script, command]) => `| \`${script}\` | \`${command}\` |`),
  ].filter(Boolean);
  const forbidden = [
    "preload.ts",
    'root = "./tests"',
    "| `test` | `node scripts/check-single-effect-version.mjs && node scripts/check-dependency-boundaries.mjs && pnpm -r test` |",
    "| `smithers-orchestrator` | `./packages/smithers/src/index.js` |",
    "| `smithers-orchestrator/gateway` | `./packages/server/src/gateway.js` |",
    "| `smithers-orchestrator/sandbox` | `./packages/sandbox/src/index.js` |",
    "| `smithers-orchestrator/server` | `./packages/server/src/index.js` |",
    "| `smithers-orchestrator/observability` | `./apps/observability/src/index.js` |",
    "| `smithers-orchestrator/dom/renderer` | `./packages/react-reconciler/src/dom/renderer.js` |",
    "| `smithers-orchestrator/scorers` | `./packages/scorers/src/index.js` |",
    "| `smithers-orchestrator/memory` | `./packages/memory/src/index.js` |",
    "| `smithers-orchestrator/openapi` | `./packages/openapi/src/index.js` |",
    "The scoped workspace packages below are published for advanced integrations",
  ];
  const missing = required.filter((needle) => !docs.includes(needle));
  const stale = forbidden.filter((needle) => docs.includes(needle));
  if (
    missing.length ||
    stale.length ||
    missingWorkspacePackageRows.length ||
    extraWorkspacePackageRows.length ||
    missingRootWorkspaceDeps.length ||
    missingFacadeWrapperFiles.length ||
    !runtimePreload ||
    !testRoot ||
    !testPreload
  ) {
    failed = true;
    console.error("\n✗ Package configuration docs must match root package.json and bunfig.toml:");
    if (!runtimePreload) console.error("    could not read root bunfig.toml preload");
    if (!testRoot) console.error("    could not read bunfig.toml [test].root");
    if (!testPreload) console.error("    could not read bunfig.toml [test].preload");
    if (missing.length) console.error(`    missing: ${missing.join(", ")}`);
    if (stale.length) console.error(`    stale: ${stale.join(", ")}`);
    if (missingWorkspacePackageRows.length) console.error(`    missing workspace package rows: ${missingWorkspacePackageRows.join(", ")}`);
    if (extraWorkspacePackageRows.length) console.error(`    extra workspace package rows: ${extraWorkspacePackageRows.join(", ")}`);
    if (missingRootWorkspaceDeps.length) console.error(`    root missing public workspace deps: ${missingRootWorkspaceDeps.join(", ")}`);
    if (missingFacadeWrapperFiles.length) {
      console.error(
        `    missing public facade wrapper files: ${missingFacadeWrapperFiles.map(({ importPath, entry }) => `${importPath} -> ${entry}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ package configuration docs match root package.json and bunfig.toml");
  }
}

function checkPiPluginDocsMatchPackageRuntime() {
  const files = new Map([
    [PI_INTEGRATION, readFileSync(PI_INTEGRATION, "utf8")],
    [PI_PLUGIN_PACKAGE_JSON, readFileSync(PI_PLUGIN_PACKAGE_JSON, "utf8")],
    [ROOT_PACKAGE_JSON, readFileSync(ROOT_PACKAGE_JSON, "utf8")],
  ]);
  const required = [
    [PI_INTEGRATION, "Drive Smithers server APIs from a PI extension or Bun process via `@smithers-orchestrator/pi-plugin`:"],
    [PI_INTEGRATION, 'import { runWorkflow, approve, streamEvents } from "@smithers-orchestrator/pi-plugin";'],
    [PI_INTEGRATION, "`@smithers-orchestrator/pi-plugin` currently publishes TypeScript source entrypoints"],
    [PI_PLUGIN_PACKAGE_JSON, '"import": "./src/index.ts"'],
    [ROOT_PACKAGE_JSON, '"@smithers-orchestrator/pi-plugin": "workspace:*"'],
  ];
  const forbidden = [
    [PI_INTEGRATION, "any Node process"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ PI plugin docs must match the TypeScript-source package runtime:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ PI plugin docs match TypeScript-source package runtime");
  }
}

function checkVcsHelperDocsMatchCurrentExports() {
  const files = new Map([
    [VCS_HELPERS_REFERENCE, readFileSync(VCS_HELPERS_REFERENCE, "utf8")],
    [VCS_PACKAGE_JSON, readFileSync(VCS_PACKAGE_JSON, "utf8")],
    [VCS_INDEX_SOURCE, readFileSync(VCS_INDEX_SOURCE, "utf8")],
    [VCS_JJ_SOURCE, readFileSync(VCS_JJ_SOURCE, "utf8")],
    [VCS_DECLARATIONS, readFileSync(VCS_DECLARATIONS, "utf8")],
    [SMITHERS_FACADE_DECLARATIONS, readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8")],
  ]);
  const expectedRuntimeExports = [
    "captureWorkspaceSnapshot",
    "findVcsRoot",
    "getJjPointer",
    "isJjRepo",
    "resolveGitBinary",
    "resolveJjBinary",
    "revertToJjPointer",
    "runJj",
    "vcsToolingStatus",
    "workspaceAdd",
    "workspaceClose",
    "workspaceList",
  ];
  const runtimeImport = spawnSync(
    process.execPath,
    [
      "-e",
      "import('./packages/vcs/src/index.js').then((m)=>console.log(Object.keys(m).sort().join('\\n'))).catch((e)=>{console.error(e.message);process.exit(1);})",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const runtimeExports = runtimeImport.status === 0
    ? runtimeImport.stdout.trim().split(/\n/).filter(Boolean)
    : [];
  const missingRuntimeExports = expectedRuntimeExports.filter((name) => !runtimeExports.includes(name));
  const extraRuntimeExports = runtimeExports.filter((name) => !expectedRuntimeExports.includes(name));
  const required = [
    [VCS_HELPERS_REFERENCE, "The root `smithers-orchestrator` facade exports the main JJ helpers:"],
    [VCS_HELPERS_REFERENCE, "The lower-level VCS package also exports repository discovery, binary resolution, tooling preflight, and snapshot capture helpers:"],
    [VCS_HELPERS_REFERENCE, 'import type * as CommandExecutor from "@effect/platform/CommandExecutor";'],
    [VCS_HELPERS_REFERENCE, 'import * as BunContext from "@effect/platform-bun/BunContext";'],
    [VCS_HELPERS_REFERENCE, "type VcsEffect<A> = Effect.Effect<A, never, CommandExecutor.CommandExecutor>;"],
    [VCS_HELPERS_REFERENCE, 'const result = await runVcs(runJj(["status"], { cwd: "/path/to/repo" }));'],
    [VCS_HELPERS_REFERENCE, "function runJj(args: string[], opts?: RunJjOptions): VcsEffect<RunJjResult>;"],
    [VCS_HELPERS_REFERENCE, "function getJjPointer(cwd?: string): VcsEffect<string | null>;"],
    [VCS_HELPERS_REFERENCE, "function isJjRepo(cwd?: string): VcsEffect<boolean>;"],
    [VCS_HELPERS_REFERENCE, "function workspaceList(cwd?: string): VcsEffect<WorkspaceInfo[]>;"],
    [VCS_HELPERS_REFERENCE, "): VcsEffect<WorkspaceResult>;"],
    [VCS_HELPERS_REFERENCE, "## `captureWorkspaceSnapshot(cwd?)`"],
    [VCS_HELPERS_REFERENCE, "This helper is exported by `@smithers-orchestrator/vcs`, not by the root facade."],
    [VCS_HELPERS_REFERENCE, "function captureWorkspaceSnapshot(cwd?: string): VcsEffect<WorkspaceSnapshot | null>;"],
    [VCS_HELPERS_REFERENCE, "function findVcsRoot(startDir: string): Effect.Effect<VcsRoot | null, never, never>;"],
    [VCS_HELPERS_REFERENCE, "function resolveGitBinary(): ResolvedBinary;"],
    [VCS_HELPERS_REFERENCE, "function resolveJjBinary(): ResolvedBinary;"],
    [VCS_HELPERS_REFERENCE, "function vcsToolingStatus(): VcsToolingStatus;"],
    [VCS_PACKAGE_JSON, '"build": "rm -f src/index.d.ts && tsup --dts-only"'],
    [VCS_INDEX_SOURCE, 'export * from "./find-root.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./jj.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./resolveGitBinary.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./resolveJjBinary.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./vcsToolingStatus.js";'],
    [VCS_JJ_SOURCE, "@typedef {object} WorkspaceSnapshot"],
    [VCS_JJ_SOURCE, "export function captureWorkspaceSnapshot(cwd)"],
    [VCS_DECLARATIONS, "declare function captureWorkspaceSnapshot(cwd?: string): Effect.Effect<WorkspaceSnapshot | null, never, _effect_platform_CommandExecutor.CommandExecutor>;"],
    [VCS_DECLARATIONS, "type WorkspaceSnapshot = {"],
    [VCS_DECLARATIONS, "export { type JjRevertResult, type RunJjOptions, type RunJjResult, type VcsToolingStatus, type WorkspaceAddOptions, type WorkspaceInfo, type WorkspaceResult, type WorkspaceSnapshot, captureWorkspaceSnapshot,"],
    [SMITHERS_FACADE_DECLARATIONS, "export { getJjPointer, isJjRepo, revertToJjPointer, runJj, workspaceAdd, workspaceClose, workspaceList } from '@smithers-orchestrator/vcs/jj';"],
  ];
  const forbidden = [
    [VCS_HELPERS_REFERENCE, "Promise<string | null>"],
    [VCS_HELPERS_REFERENCE, "Promise<boolean>"],
    [VCS_HELPERS_REFERENCE, "Promise<WorkspaceResult>"],
    [VCS_HELPERS_REFERENCE, "const result = await runJj(["],
    [VCS_HELPERS_REFERENCE, "const pointer = await getJjPointer("],
    [VCS_HELPERS_REFERENCE, "const result = await revertToJjPointer("],
    [VCS_HELPERS_REFERENCE, "const enabled = await isJjRepo("],
    [VCS_HELPERS_REFERENCE, "const result = await workspaceAdd("],
    [VCS_HELPERS_REFERENCE, "const workspaces = await workspaceList("],
    [VCS_HELPERS_REFERENCE, "const result = await workspaceClose("],
    [VCS_INDEX_SOURCE, 'export * from "./ResolvedBinary.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./JjRevertResult.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./RunJjOptions.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./RunJjResult.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./WorkspaceAddOptions.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./WorkspaceInfo.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./WorkspaceResult.js";'],
    [VCS_INDEX_SOURCE, 'export * from "./WorkspaceSnapshot.js";'],
    [VCS_DECLARATIONS, "export { type VcsToolingStatus, findVcsRoot, getJjPointer"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (
    runtimeImport.status !== 0 ||
    missing.length ||
    stale.length ||
    missingRuntimeExports.length ||
    extraRuntimeExports.length
  ) {
    failed = true;
    console.error("\n✗ VCS helper docs must match the current runtime exports and Effect declarations:");
    if (runtimeImport.status !== 0) console.error(`    runtime import failed: ${runtimeImport.stderr.trim()}`);
    if (missingRuntimeExports.length) console.error(`    missing runtime exports: ${missingRuntimeExports.join(", ")}`);
    if (extraRuntimeExports.length) console.error(`    undocumented runtime exports: ${extraRuntimeExports.join(", ")}`);
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ VCS helper docs match runtime exports and Effect declarations");
  }
}

function checkTimeTravelDocsMatchCurrentExports() {
  const files = new Map([
    [RUNTIME_REVERT_REFERENCE, readFileSync(RUNTIME_REVERT_REFERENCE, "utf8")],
    [RECIPES_DOC, readFileSync(RECIPES_DOC, "utf8")],
    [SMITHERS_FACADE_SOURCE, readFileSync(SMITHERS_FACADE_SOURCE, "utf8")],
    [SMITHERS_FACADE_DECLARATIONS, readFileSync(SMITHERS_FACADE_DECLARATIONS, "utf8")],
    [TIME_TRAVEL_PACKAGE_JSON, readFileSync(TIME_TRAVEL_PACKAGE_JSON, "utf8")],
    [TIME_TRAVEL_INDEX_SOURCE, readFileSync(TIME_TRAVEL_INDEX_SOURCE, "utf8")],
    [TIME_TRAVEL_DECLARATIONS, readFileSync(TIME_TRAVEL_DECLARATIONS, "utf8")],
    [OBSERVABILITY_INDEX_SOURCE, readFileSync(OBSERVABILITY_INDEX_SOURCE, "utf8")],
    [OBSERVABILITY_DECLARATIONS, readFileSync(OBSERVABILITY_DECLARATIONS, "utf8")],
  ]);
  const expectedTimeTravelExports = [
    "revertToAttempt",
    "timeTravel",
    "snapshotsCaptured",
    "runForksCreated",
    "replaysStarted",
    "snapshotDuration",
  ];
  const runtimeImport = spawnSync(
    process.execPath,
    [
      "-e",
      "import('./packages/time-travel/src/index.js').then((m)=>console.log(Object.keys(m).sort().join('\\n'))).catch((e)=>{console.error(e.message);process.exit(1);})",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const runtimeExports = runtimeImport.status === 0
    ? runtimeImport.stdout.trim().split(/\n/).filter(Boolean)
    : [];
  const missingRuntimeExports = expectedTimeTravelExports.filter((name) => !runtimeExports.includes(name));
  const required = [
    [RUNTIME_REVERT_REFERENCE, 'import { revertToAttempt, timeTravel } from "smithers-orchestrator";'],
    [RUNTIME_REVERT_REFERENCE, "const result = await revertToAttempt(adapter, {"],
    [RUNTIME_REVERT_REFERENCE, "function revertToAttempt(adapter: SmithersDb, opts: RevertOptions): Promise<RevertResult>;"],
    [RUNTIME_REVERT_REFERENCE, "const reset = await timeTravel(adapter, {"],
    [RUNTIME_REVERT_REFERENCE, "function timeTravel(adapter: SmithersDb, opts: TimeTravelOptions): Promise<TimeTravelResult>;"],
    [RECIPES_DOC, "Smithers records the current JJ change ID in `_smithers_attempts.jj_pointer` per attempt."],
    [SMITHERS_FACADE_SOURCE, 'export { revertToAttempt } from "@smithers-orchestrator/time-travel/revert";'],
    [SMITHERS_FACADE_SOURCE, 'export { timeTravel } from "@smithers-orchestrator/time-travel/timetravel";'],
    [SMITHERS_FACADE_DECLARATIONS, "export { revertToAttempt } from '@smithers-orchestrator/time-travel/revert';"],
    [SMITHERS_FACADE_DECLARATIONS, "export { timeTravel } from '@smithers-orchestrator/time-travel/timetravel';"],
    [TIME_TRAVEL_PACKAGE_JSON, '"build": "rm -f src/index.d.ts && tsup --dts-only"'],
    [TIME_TRAVEL_INDEX_SOURCE, 'export { revertToAttempt } from "./revert.js";'],
    [TIME_TRAVEL_INDEX_SOURCE, 'export { timeTravel } from "./timetravel.js";'],
    [TIME_TRAVEL_DECLARATIONS, "declare function revertToAttempt("],
    [TIME_TRAVEL_DECLARATIONS, "declare function timeTravel("],
    [TIME_TRAVEL_DECLARATIONS, "type RevertOptions"],
    [TIME_TRAVEL_DECLARATIONS, "type TimeTravelOptions"],
    [TIME_TRAVEL_DECLARATIONS, "revertToAttempt,"],
    [TIME_TRAVEL_DECLARATIONS, "timeTravel,"],
    [OBSERVABILITY_INDEX_SOURCE, "snapshotsCaptured, runForksCreated, replaysStarted, snapshotDuration"],
    [OBSERVABILITY_DECLARATIONS, "snapshotsCaptured"],
    [OBSERVABILITY_DECLARATIONS, "runForksCreated"],
    [OBSERVABILITY_DECLARATIONS, "replaysStarted"],
    [OBSERVABILITY_DECLARATIONS, "snapshotDuration"],
  ];
  const forbidden = [
    [RECIPES_DOC, "jj change ID (or git SHA)"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (runtimeImport.status !== 0 || missingRuntimeExports.length || missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Revert/time-travel docs and declarations must match public exports:");
    if (runtimeImport.status !== 0) console.error(`    runtime import failed: ${runtimeImport.stderr.trim()}`);
    if (missingRuntimeExports.length) console.error(`    missing runtime exports: ${missingRuntimeExports.join(", ")}`);
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Revert/time-travel docs and declarations match public exports");
  }
}

function normalizeCliManifestCommand(command) {
  return command
    .trim()
    .replace(/\s+(?:<[^>]+>|\[[^\]]+\])/g, "")
    .trim()
    .replace(/\s+/g, ".");
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function runCli(args) {
  return spawnSync("bun", [CLI_ENTRYPOINT, ...args], { cwd: root, encoding: "utf8" });
}

function readCliOverviewToonCommandBlock(commandName) {
  const docs = readFileSync(CLI_OVERVIEW, "utf8");
  const toon = docs.match(/```toon\ncommands\[\d+\]:\n([\s\S]*?)\n```/)?.[1];
  const marker = `  - name: ${commandName}\n`;
  const start = toon?.indexOf(marker) ?? -1;
  if (!toon || start === -1) return undefined;
  const bodyStart = start + marker.length;
  const next = toon.indexOf("\n  - name: ", bodyStart);
  return toon.slice(bodyStart, next === -1 ? undefined : next);
}

function readCliOverviewToonFlags(commandName) {
  const block = readCliOverviewToonCommandBlock(commandName);
  if (!block) return undefined;
  const lines = block.split("\n");
  const headerIndex = lines.findIndex((line) => /^    flags\[(\d+)\]\{[^}]+\}:$/.test(line));
  if (headerIndex === -1) return undefined;
  const header = lines[headerIndex].match(/^    flags\[(\d+)\]\{[^}]+\}:$/);
  const flags = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const flag = line.match(/^      ([^,]+),/);
    if (!flag) break;
    flags.push(flag[1].trim());
  }
  return {
    declaredCount: Number(header[1]),
    flags,
  };
}

function checkStudioDocsMatchCurrentAppSurface() {
  const files = new Map([
    [PACKAGE_CONFIGURATION_REFERENCE, readFileSync(PACKAGE_CONFIGURATION_REFERENCE, "utf8")],
    [CUSTOM_WORKFLOW_UI_GUIDE, readFileSync(CUSTOM_WORKFLOW_UI_GUIDE, "utf8")],
    [WATCH_AND_STEER_GUIDE, readFileSync(WATCH_AND_STEER_GUIDE, "utf8")],
    [STUDIO_APP_PACKAGE_JSON, readFileSync(STUDIO_APP_PACKAGE_JSON, "utf8")],
    [STUDIO_APP_README, readFileSync(STUDIO_APP_README, "utf8")],
    [STUDIO_RUNS_PARSE_SOURCE, readFileSync(STUDIO_RUNS_PARSE_SOURCE, "utf8")],
    [ROOT_PACKAGE_JSON, readFileSync(ROOT_PACKAGE_JSON, "utf8")],
  ]);
  const required = [
    [STUDIO_APP_PACKAGE_JSON, '"name": "@smithers-orchestrator/smithers-studio-2"'],
    [ROOT_PACKAGE_JSON, '"dev:studio": "bun apps/smithers-studio-2/scripts/dev.ts"'],
    [STUDIO_RUNS_PARSE_SOURCE, "parseWorkflowUiPaths"],
    [STUDIO_RUNS_PARSE_SOURCE, "workflowKey"],
    [STUDIO_RUNS_PARSE_SOURCE, "uiPath"],
    [PACKAGE_CONFIGURATION_REFERENCE, "`@smithers-orchestrator/smithers-studio-2` | Next Smithers Studio UI shell for browsing workspaces, launching workflows, watching live runs, and embedding custom workflow UIs"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "Studio 2's Runs surface"],
    [WATCH_AND_STEER_GUIDE, "## Studio: the visual console"],
    [WATCH_AND_STEER_GUIDE, "`pnpm dev:studio` starts the Studio 2 dev stack"],
    [STUDIO_APP_README, "`pnpm dev:studio` from the repo root starts the Smithers Gateway, workspace API, and Studio 2 together."],
    [STUDIO_APP_README, "The **Runs** and **Workflows** surfaces use this for"],
  ];
  const forbidden = [
    [PACKAGE_CONFIGURATION_REFERENCE, "Smithers Studio UI shell for browsing and driving workflow runs (coming soon)"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "Studio 2 (coming soon)"],
    [WATCH_AND_STEER_GUIDE, "## Studio: the visual console (coming soon)"],
    [WATCH_AND_STEER_GUIDE, "Studio is coming soon"],
    [WATCH_AND_STEER_GUIDE, "When Studio ships"],
    [WATCH_AND_STEER_GUIDE, "Until it lands"],
    [STUDIO_APP_README, "`npm run dev` from the repo root starts the Smithers Gateway and Studio 2 together."],
    [STUDIO_APP_README, "until it lands, Runs"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Studio docs must match the current Studio 2 app surface:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Studio docs match current Studio 2 app surface");
  }
}

function checkCliOverviewCommandCatalogMatchesCli() {
  const docs = readFileSync(CLI_OVERVIEW, "utf8");
  const block = docs.match(/```toon\ncommands\[(\d+)\]:\n([\s\S]*?)\n```/);
  const declaredCount = block ? Number(block[1]) : NaN;
  const documented = block
    ? [...block[2].matchAll(/^  - name: ([^\n]+)/gm)].map((match) => match[1].trim().replace(/^"|"$/g, ""))
    : [];
  const llms = runCli(["--llms"]);
  const topLevelHelp = runCli(["--help"]);
  const mcpHelp = runCli(["mcp", "--help"]);
  const skillsHelp = runCli(["skills", "--help"]);
  const completionsHelp = runCli(["completions", "--help"]);
  const cliCommands =
    llms.status === 0
      ? [...llms.stdout.matchAll(/\| `smithers ([^`]+)` \|/g)].map((match) =>
          normalizeCliManifestCommand(match[1]),
        )
      : [];
  const documentedSet = new Set(documented);
  const missingCliCommands = cliCommands.filter((command) => !documentedSet.has(command));
  const integrationEvidence = [
    ["completions", topLevelHelp.stdout.includes("completions") && completionsHelp.stdout.includes("Usage: smithers completions")],
    ["mcp.add", topLevelHelp.stdout.includes("mcp add") && mcpHelp.stdout.includes("add  Register as MCP server")],
    ["skills.add", topLevelHelp.stdout.includes("skills") && skillsHelp.stdout.includes("add   Sync skill files to agents")],
    ["skills.list", topLevelHelp.stdout.includes("skills") && skillsHelp.stdout.includes("list  List skills")],
  ];
  const missingIntegrationDocs = integrationEvidence
    .filter(([command, backedByCli]) => backedByCli && !documentedSet.has(command))
    .map(([command]) => command);
  const missingIntegrationHelp = integrationEvidence
    .filter(([, backedByCli]) => !backedByCli)
    .map(([command]) => command);
  if (
    !block ||
    declaredCount !== documented.length ||
    llms.status !== 0 ||
    topLevelHelp.status !== 0 ||
    mcpHelp.status !== 0 ||
    skillsHelp.status !== 0 ||
    completionsHelp.status !== 0 ||
    missingCliCommands.length ||
    missingIntegrationDocs.length ||
    missingIntegrationHelp.length
  ) {
    failed = true;
    console.error("\n✗ docs/cli/overview.mdx command catalog must match the live CLI:");
    if (!block) console.error("    TOON command catalog block not found");
    if (block && declaredCount !== documented.length) {
      console.error(`    commands[${declaredCount}] declares ${declaredCount}, but documents ${documented.length}`);
    }
    if (llms.status !== 0) console.error(`    bun apps/cli/src/index.js --llms failed with status ${llms.status}`);
    if (topLevelHelp.status !== 0) console.error(`    bun apps/cli/src/index.js --help failed with status ${topLevelHelp.status}`);
    if (mcpHelp.status !== 0) console.error(`    bun apps/cli/src/index.js mcp --help failed with status ${mcpHelp.status}`);
    if (skillsHelp.status !== 0) {
      console.error(`    bun apps/cli/src/index.js skills --help failed with status ${skillsHelp.status}`);
    }
    if (completionsHelp.status !== 0) {
      console.error(`    bun apps/cli/src/index.js completions --help failed with status ${completionsHelp.status}`);
    }
    if (missingCliCommands.length) console.error(`    missing CLI manifest commands: ${missingCliCommands.join(", ")}`);
    if (missingIntegrationDocs.length) {
      console.error(`    missing integration commands: ${missingIntegrationDocs.join(", ")}`);
    }
    if (missingIntegrationHelp.length) {
      console.error(`    documented integration commands are not backed by CLI help: ${missingIntegrationHelp.join(", ")}`);
    }
  } else {
    console.log("✓ CLI overview command catalog matches live CLI command names");
  }
}

function checkCliOverviewWorkflowRunFlagsMatchSchema() {
  const documented = readCliOverviewToonFlags("workflow.run");
  const schemaResult = runCli(["workflow", "run", "--schema", "--format", "json"]);
  let schema;
  if (schemaResult.status === 0) {
    try {
      schema = JSON.parse(schemaResult.stdout);
    } catch {
      // handled below
    }
  }
  const schemaFlags = Object.keys(schema?.options?.properties ?? {}).map(camelToKebab);
  const missing = documented ? schemaFlags.filter((flag) => !documented.flags.includes(flag)) : [];
  const extra = documented ? documented.flags.filter((flag) => !schemaFlags.includes(flag)) : [];
  if (
    !documented ||
    documented.declaredCount !== documented.flags.length ||
    schemaResult.status !== 0 ||
    !schema ||
    missing.length ||
    extra.length
  ) {
    failed = true;
    console.error("\n✗ docs/cli/overview.mdx workflow.run flags must match the live CLI schema:");
    if (!documented) console.error("    workflow.run flags block not found");
    if (documented && documented.declaredCount !== documented.flags.length) {
      console.error(
        `    flags[${documented.declaredCount}] declares ${documented.declaredCount}, but documents ${documented.flags.length}`,
      );
    }
    if (schemaResult.status !== 0) {
      console.error(`    bun apps/cli/src/index.js workflow run --schema --format json failed with status ${schemaResult.status}`);
    }
    if (schemaResult.status === 0 && !schema) console.error("    workflow.run schema output was not valid JSON");
    if (missing.length) console.error(`    missing schema flags: ${missing.join(", ")}`);
    if (extra.length) console.error(`    extra documented flags: ${extra.join(", ")}`);
  } else {
    console.log("✓ CLI overview workflow.run flags match live CLI schema");
  }
}

function checkToolDocsMatchCurrentRuntimeLogging() {
  const docs = readFileSync(TOOLS_INTEGRATION, "utf8");
  const engine = readFileSync(ENGINE_SOURCE, "utf8");
  const required = [
    "Smithers creates the `_smithers_tool_calls` table and exposes adapter methods to insert and list rows.",
    "The current engine reads that table on retry to build warnings for previously recorded non-idempotent side-effect tool calls.",
    "The `defineTool()` wrapper itself does not insert a durable row for every call",
    "`defineTool()` wraps custom [AI SDK](https://ai-sdk.dev) tools with Smithers runtime context, deterministic idempotency keys, side-effect metadata, and the side-effect snapshot hook.",
    "`idempotent: false` marks the tool for retry warnings when a previous attempt has a recorded `_smithers_tool_calls` row.",
    "`defineTool()` does not persist `_smithers_tool_calls` rows directly",
  ];
  const forbidden = [
    "Every invocation is logged to `_smithers_tool_calls`:",
    "Every `defineTool()` call is logged to `_smithers_tool_calls`.",
    "durable tool-call logging",
  ];
  const missing = required.filter((needle) => !docs.includes(needle));
  const stale = forbidden.filter((needle) => docs.includes(needle));
  const engineReadsToolCalls = engine.includes(".listToolCalls(");
  const engineInsertsToolCalls = engine.includes(".insertToolCall(");
  if (missing.length || stale.length || !engineReadsToolCalls || engineInsertsToolCalls) {
    failed = true;
    console.error("\n✗ docs/integrations/tools.mdx must match current _smithers_tool_calls runtime behavior:");
    if (!engineReadsToolCalls) console.error("    engine no longer reads tool-call rows for retry warnings");
    if (engineInsertsToolCalls) console.error("    engine now inserts tool-call rows; update docs to document full logging");
    if (missing.length) console.error(`    missing: ${missing.join(", ")}`);
    if (stale.length) console.error(`    stale: ${stale.join(", ")}`);
  } else {
    console.log("✓ tool docs describe current _smithers_tool_calls behavior");
  }
}

function checkToolDocsMatchRuntimeLimitsAndNetwork() {
  const docs = readFileSync(TOOLS_INTEGRATION, "utf8");
  const bashSource = readFileSync(join(root, "packages/smithers/src/tools/bash.js"), "utf8");
  const toolUtils = readFileSync(join(root, "packages/smithers/src/tools/utils.js"), "utf8");
  const writeSource = readFileSync(join(root, "packages/smithers/src/tools/write.js"), "utf8");
  const editSource = readFileSync(join(root, "packages/smithers/src/tools/edit.js"), "utf8");
  const required = [
    [TOOLS_INTEGRATION, "Process output is truncated to `maxOutputBytes`"],
    [TOOLS_INTEGRATION, "`read`, `write`, and `edit` reject files, content, or patches that exceed it."],
    [TOOLS_INTEGRATION, "Run an executable directly with arguments."],
    [TOOLS_INTEGRATION, "cmd: string                     // executable path/name; no shell parsing"],
    [TOOLS_INTEGRATION, "Use `args` for arguments. If you need shell syntax"],
    [TOOLS_INTEGRATION, "Smithers tokenizes `cmd` plus `args`."],
    [TOOLS_INTEGRATION, "matched for known network tools"],
    [TOOLS_INTEGRATION, "URL tokens are blocked by prefix"],
    [TOOLS_INTEGRATION, "`git` plus a `push`, `pull`, `fetch`, `clone`, or `remote` token"],
    [join(root, "packages/smithers/src/tools/bash.js"), "tokenExecutableName(token)"],
    [join(root, "packages/smithers/src/tools/bash.js"), 'description: "Run an executable with arguments"'],
    [join(root, "packages/smithers/src/tools/bash.js"), "String(part).split(/\\s+/).filter(Boolean)"],
    [join(root, "packages/smithers/src/tools/bash.js"), "executables.has(name)"],
    [join(root, "packages/smithers/src/tools/bash.js"), "token.startsWith(scheme)"],
    [join(root, "packages/smithers/src/tools/bash.js"), 'new Set(["push", "pull", "fetch", "clone", "remote"])'],
    [join(root, "packages/smithers/src/tools/utils.js"), "spawn(command, args"],
    [join(root, "packages/smithers/src/tools/utils.js"), "truncateToBytes(text, maxBytes)"],
    [join(root, "packages/smithers/src/tools/utils.js"), "assertReadableFileWithinLimit(path, maxBytes)"],
    [join(root, "packages/smithers/src/tools/write.js"), "Content too large"],
    [join(root, "packages/smithers/src/tools/edit.js"), "Patch too large"],
  ];
  const sourceByFile = new Map([
    [TOOLS_INTEGRATION, docs],
    [join(root, "packages/smithers/src/tools/bash.js"), bashSource],
    [join(root, "packages/smithers/src/tools/utils.js"), toolUtils],
    [join(root, "packages/smithers/src/tools/write.js"), writeSource],
    [join(root, "packages/smithers/src/tools/edit.js"), editSource],
  ]);
  const forbidden = [
    [TOOLS_INTEGRATION, "Output size | Truncated to `maxOutputBytes`"],
    [TOOLS_INTEGRATION, "checked against these fragments"],
    [TOOLS_INTEGRATION, "| Category | Blocked strings |"],
    [TOOLS_INTEGRATION, "command string (executable + args) is checked"],
    [TOOLS_INTEGRATION, "cmd: string                     // executable or command"],
  ];
  const missing = required.filter(([file, needle]) => !sourceByFile.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => sourceByFile.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ docs/integrations/tools.mdx must match current tool limit and network behavior:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ tool docs describe current limit and network behavior");
  }
}

function checkMemoryDocsMatchSourceTypes() {
  const memoryStoreFactorySource = join(root, "packages/memory/src/store/createMemoryStore.js");
  const files = new Map([
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [MEMORY_CONCEPTS, readFileSync(MEMORY_CONCEPTS, "utf8")],
    [MEMORY_TASK_CONFIG_SOURCE, readFileSync(MEMORY_TASK_CONFIG_SOURCE, "utf8")],
    [MEMORY_WORKING_CONFIG_SOURCE, readFileSync(MEMORY_WORKING_CONFIG_SOURCE, "utf8")],
    [MEMORY_SEMANTIC_RECALL_CONFIG_SOURCE, readFileSync(MEMORY_SEMANTIC_RECALL_CONFIG_SOURCE, "utf8")],
    [MEMORY_MESSAGE_HISTORY_CONFIG_SOURCE, readFileSync(MEMORY_MESSAGE_HISTORY_CONFIG_SOURCE, "utf8")],
    [MEMORY_SERVICE_API_SOURCE, readFileSync(MEMORY_SERVICE_API_SOURCE, "utf8")],
    [MEMORY_PROCESSOR_SOURCE, readFileSync(MEMORY_PROCESSOR_SOURCE, "utf8")],
    [MEMORY_PROCESSOR_CONFIG_SOURCE, readFileSync(MEMORY_PROCESSOR_CONFIG_SOURCE, "utf8")],
    [MEMORY_LAYER_CONFIG_SOURCE, readFileSync(MEMORY_LAYER_CONFIG_SOURCE, "utf8")],
    [memoryStoreFactorySource, readFileSync(memoryStoreFactorySource, "utf8")],
  ]);
  const required = [
    [MEMORY_TASK_CONFIG_SOURCE, "namespace?: string | MemoryNamespace;"],
    [MEMORY_WORKING_CONFIG_SOURCE, "export type WorkingMemoryConfig<"],
    [MEMORY_WORKING_CONFIG_SOURCE, "schema?: T;"],
    [MEMORY_WORKING_CONFIG_SOURCE, "ttlMs?: number;"],
    [MEMORY_SEMANTIC_RECALL_CONFIG_SOURCE, "export type SemanticRecallConfig = {"],
    [MEMORY_SEMANTIC_RECALL_CONFIG_SOURCE, "similarityThreshold?: number;"],
    [MEMORY_MESSAGE_HISTORY_CONFIG_SOURCE, "export type MessageHistoryConfig = {"],
    [MEMORY_MESSAGE_HISTORY_CONFIG_SOURCE, "lastMessages?: number;"],
    [MEMORY_SERVICE_API_SOURCE, "export type MemoryServiceApi = {"],
    [MEMORY_SERVICE_API_SOURCE, "readonly store: MemoryStore;"],
    [MEMORY_PROCESSOR_SOURCE, "export type MemoryProcessor = {"],
    [MEMORY_PROCESSOR_SOURCE, "processEffect: (store: MemoryStore) => Effect.Effect<void, SmithersError>;"],
    [MEMORY_PROCESSOR_CONFIG_SOURCE, "export type MemoryProcessorConfig = {"],
    [MEMORY_PROCESSOR_CONFIG_SOURCE, "processors?: string[];"],
    [MEMORY_LAYER_CONFIG_SOURCE, "export type MemoryLayerConfig = {"],
    [MEMORY_LAYER_CONFIG_SOURCE, "db: BunSQLiteDatabase<Record<string, unknown>>;"],
    [TYPES_REFERENCE, "namespace?: string | MemoryNamespace;"],
    [TYPES_REFERENCE, "recall?: { namespace?: MemoryNamespace; query?: string; topK?: number };"],
    [TYPES_REFERENCE, "remember?: { namespace?: MemoryNamespace; key?: string };"],
    [TYPES_REFERENCE, "type WorkingMemoryConfig<"],
    [TYPES_REFERENCE, "schema?: T;"],
    [TYPES_REFERENCE, "type SemanticRecallConfig = {"],
    [TYPES_REFERENCE, "similarityThreshold?: number;"],
    [TYPES_REFERENCE, "type MessageHistoryConfig = {"],
    [TYPES_REFERENCE, "lastMessages?: number;"],
    [TYPES_REFERENCE, "type MemoryServiceApi = {"],
    [TYPES_REFERENCE, "readonly store: MemoryStore;"],
    [TYPES_REFERENCE, "type MemoryProcessorConfig = {"],
    [TYPES_REFERENCE, "processors?: string[];"],
    [TYPES_REFERENCE, "type MemoryProcessor = {"],
    [TYPES_REFERENCE, "processEffect: (store: MemoryStore) => Effect.Effect<void, SmithersError>;"],
    [TYPES_REFERENCE, "type MemoryLayerConfig = {"],
    [TYPES_REFERENCE, 'import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>;'],
    [memoryStoreFactorySource, "BunSQLiteDatabase"],
    [MEMORY_CONCEPTS, 'import { drizzle } from "drizzle-orm/bun-sqlite";'],
    [MEMORY_CONCEPTS, 'const sqlite = new Database("smithers.db");'],
    [MEMORY_CONCEPTS, "const db = drizzle(sqlite);"],
    [MEMORY_CONCEPTS, "const store = createMemoryStore(db);"],
  ];
  const forbidden = [
    [TYPES_REFERENCE, "type TaskMemoryConfig = {\n  recall?: { namespace?: MemoryNamespace; query?: string; topK?: number };"],
    [TYPES_REFERENCE, "type WorkingMemoryConfig = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type SemanticRecallConfig = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type MessageHistoryConfig = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type MemoryServiceApi = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type MemoryProcessor = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type MemoryLayerConfig = { db: unknown };"],
    [MEMORY_CONCEPTS, 'createMemoryStore(new Database("smithers.db"))'],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Memory docs must match exported memory package types:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Memory docs match exported memory package types");
  }
}

function checkScorerDocsMatchSourceTypes() {
  const files = new Map([
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [RECIPES_DOC, readFileSync(RECIPES_DOC, "utf8")],
    [SCORER_TYPES_SOURCE, readFileSync(SCORER_TYPES_SOURCE, "utf8")],
    [SCORER_AGGREGATE_OPTIONS_SOURCE, readFileSync(SCORER_AGGREGATE_OPTIONS_SOURCE, "utf8")],
    [LLM_JUDGE_CONFIG_SOURCE, readFileSync(LLM_JUDGE_CONFIG_SOURCE, "utf8")],
    [CREATE_SCORER_CONFIG_SOURCE, readFileSync(CREATE_SCORER_CONFIG_SOURCE, "utf8")],
  ]);
  const required = [
    [SCORER_TYPES_SOURCE, '| { type: "ratio"; rate: number }'],
    [SCORER_TYPES_SOURCE, "export type ScoreRow = {"],
    [SCORER_TYPES_SOURCE, 'source: "live" | "batch";'],
    [SCORER_TYPES_SOURCE, "durationMs: number | null;"],
    [SCORER_TYPES_SOURCE, "export type AggregateScore = {"],
    [SCORER_TYPES_SOURCE, "stddev: number;"],
    [SCORER_TYPES_SOURCE, "export type ScorerContext = {"],
    [SCORER_AGGREGATE_OPTIONS_SOURCE, "runId?: string;"],
    [SCORER_AGGREGATE_OPTIONS_SOURCE, "nodeId?: string;"],
    [SCORER_AGGREGATE_OPTIONS_SOURCE, "scorerId?: string;"],
    [LLM_JUDGE_CONFIG_SOURCE, "judge: AgentLike;"],
    [LLM_JUDGE_CONFIG_SOURCE, "instructions: string;"],
    [LLM_JUDGE_CONFIG_SOURCE, "promptTemplate: (input: ScorerInput) => string;"],
    [CREATE_SCORER_CONFIG_SOURCE, "score: ScorerFn;"],
    [TYPES_REFERENCE, "type ScoreRow = {"],
    [TYPES_REFERENCE, 'source: "live" | "batch";'],
    [TYPES_REFERENCE, "durationMs: number | null;"],
    [TYPES_REFERENCE, "type AggregateScore = {"],
    [TYPES_REFERENCE, "stddev: number;"],
    [TYPES_REFERENCE, "type AggregateOptions = {"],
    [TYPES_REFERENCE, "scorerId?: string;"],
    [TYPES_REFERENCE, "type ScorerContext = {"],
    [TYPES_REFERENCE, "judge: AgentLike;"],
    [TYPES_REFERENCE, "instructions: string;"],
    [TYPES_REFERENCE, "promptTemplate: (input: ScorerInput) => string;"],
    [TYPES_REFERENCE, "score: ScorerFn;"],
    [RECIPES_DOC, 'sampling: { type: "ratio", rate: 0.1 },'],
    [RECIPES_DOC, 'id: "analysis-quality",'],
    [RECIPES_DOC, "judge: analyst,"],
    [RECIPES_DOC, "promptTemplate: ({ input, output }) =>"],
  ];
  const forbidden = [
    [TYPES_REFERENCE, "type LlmJudgeConfig    = { model: string; systemPrompt?: string; temperature?: number; maxTokens?: number };"],
    [TYPES_REFERENCE, "model: string;\n  criteria: string;"],
    [TYPES_REFERENCE, "examples?: Array<{ input: unknown; output: unknown; score: number; explanation: string }>;"],
    [TYPES_REFERENCE, "type ScoreRow = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type AggregateScore = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type ScorerContext = Record<string, unknown>;"],
    [RECIPES_DOC, "llmJudge({ model:"],
    [RECIPES_DOC, "prompt: \"Rate the analysis quality 0-1\""],
    [RECIPES_DOC, 'sampling: { kind: "ratio", ratio: 0.1 },'],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Scorer docs must match current scorer package types:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Scorer docs match current scorer package types");
  }
}

function checkOpenApiDocsMatchCurrentPackage() {
  const files = new Map([
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [OPENAPI_CONCEPTS, readFileSync(OPENAPI_CONCEPTS, "utf8")],
    [COMMON_TOOLS_INTEGRATION, readFileSync(COMMON_TOOLS_INTEGRATION, "utf8")],
    [PACKAGE_CONFIGURATION_REFERENCE, readFileSync(PACKAGE_CONFIGURATION_REFERENCE, "utf8")],
    [RUNTIME_EVENTS_REFERENCE, readFileSync(RUNTIME_EVENTS_REFERENCE, "utf8")],
    [EVENT_TYPES_REFERENCE, readFileSync(EVENT_TYPES_REFERENCE, "utf8")],
    [OPENAPI_HELPERS_SOURCE, readFileSync(OPENAPI_HELPERS_SOURCE, "utf8")],
    [OPENAPI_LOAD_SPEC_EFFECT_SOURCE, readFileSync(OPENAPI_LOAD_SPEC_EFFECT_SOURCE, "utf8")],
    [OPENAPI_LOAD_SPEC_SYNC_SOURCE, readFileSync(OPENAPI_LOAD_SPEC_SYNC_SOURCE, "utf8")],
    [OPENAPI_SPEC_SOURCE, readFileSync(OPENAPI_SPEC_SOURCE, "utf8")],
    [OPENAPI_DECLARATIONS, readFileSync(OPENAPI_DECLARATIONS, "utf8")],
  ]);
  const required = [
    [TYPES_REFERENCE, "type OpenApiSpec = {"],
    [TYPES_REFERENCE, "paths: Record<string, OpenApiPathItem>;"],
    [TYPES_REFERENCE, "schemas?: Record<string, OpenApiSchemaObject>;"],
    [TYPES_REFERENCE, "requestBodies?: Record<string, OpenApiRequestBodyObject>;"],
    [OPENAPI_CONCEPTS, 'import { ToolLoopAgent } from "ai";'],
    [OPENAPI_CONCEPTS, 'import { anthropic } from "@ai-sdk/anthropic";'],
    [OPENAPI_CONCEPTS, "`loadSpecEffect(input)` | Load and parse a spec from object, path, URL, or raw text."],
    [OPENAPI_CONCEPTS, "`loadSpecSync(input)` | Load and parse a spec from object, local file path, or raw text. It does not fetch URLs."],
    [OPENAPI_CONCEPTS, "`jsonSchemaToZod(schema, spec, visited?)` / `buildOperationSchema(parameters, requestBody, spec)`"],
    [OPENAPI_CONCEPTS, "OpenAPI tool calls update the exported Effect metrics (`openApiToolCallsTotal`, `openApiToolCallErrorsTotal`, `openApiToolDuration`)"],
    [OPENAPI_CONCEPTS, "The current tool factory does not emit `OpenApiToolCalled` onto the Smithers run event bus"],
    [COMMON_TOOLS_INTEGRATION, "See [OpenAPI tools](/concepts/openapi-tools)."],
    [PACKAGE_CONFIGURATION_REFERENCE, "[OpenAPI Tools](/concepts/openapi-tools), [Tools](/integrations/tools)"],
    [RUNTIME_EVENTS_REFERENCE, "OpenApiToolCalled` is categorized as `openapi` for forward compatibility"],
    [EVENT_TYPES_REFERENCE, "OpenApiToolCalled` is typed and categorized for forward compatibility"],
    [OPENAPI_HELPERS_SOURCE, "Metric.increment(openApiToolCallsTotal)"],
    [OPENAPI_HELPERS_SOURCE, "Metric.update(openApiToolDuration, durationMs)"],
    [OPENAPI_HELPERS_SOURCE, "Effect.annotateLogs"],
    [OPENAPI_HELPERS_SOURCE, "Effect.withLogSpan"],
    [OPENAPI_LOAD_SPEC_EFFECT_SOURCE, 'str.startsWith("http://") || str.startsWith("https://")'],
    [OPENAPI_SPEC_SOURCE, "export type OpenApiSpec = {"],
    [OPENAPI_SPEC_SOURCE, "paths: Record<string, PathItem>;"],
    [OPENAPI_SPEC_SOURCE, "requestBodies?: Record<string, RequestBodyObject>;"],
    [OPENAPI_DECLARATIONS, "declare function jsonSchemaToZod(schema: SchemaObject | RefObject | undefined, spec:"],
    [OPENAPI_DECLARATIONS, "visited?: Set<string>): z.ZodType;"],
    [OPENAPI_DECLARATIONS, "declare function buildOperationSchema(parameters: ParameterObject[], requestBody: RequestBodyObject | undefined, spec:"],
  ];
  const forbidden = [
    [OPENAPI_CONCEPTS, "Each tool call emits an `OpenApiToolCalled` event"],
    [OPENAPI_CONCEPTS, "Visible via `bunx smithers-orchestrator events RUN_ID --type openapi`"],
    [OPENAPI_CONCEPTS, "`loadSpecEffect(input)` / `loadSpecSync(input)` | Load and parse a spec from object, path, URL, or raw text."],
    [OPENAPI_CONCEPTS, "`jsonSchemaToZod(schema)` / `buildOperationSchema(...)`"],
    [COMMON_TOOLS_INTEGRATION, "[OpenAPI tools](/integrations/tools)"],
    [PACKAGE_CONFIGURATION_REFERENCE, "[OpenAPI Tools](/integrations/tools), [OpenAPI Quickstart](/guides/openapi-tools-quickstart)"],
    [OPENAPI_HELPERS_SOURCE, "OpenApiToolCalled"],
    [OPENAPI_LOAD_SPEC_SYNC_SOURCE, 'startsWith("http://")'],
    [OPENAPI_LOAD_SPEC_SYNC_SOURCE, 'startsWith("https://")'],
    [TYPES_REFERENCE, "type OpenApiSpec = Record<string, unknown>;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ OpenAPI docs must match current package behavior and declarations:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ OpenAPI docs match current package behavior and declarations");
  }
}

function checkMcpIntegrationDocsMatchAgentOptions() {
  const files = new Map([
    [MCP_INTEGRATION_EXAMPLE_README, readFileSync(MCP_INTEGRATION_EXAMPLE_README, "utf8")],
    [CLAUDE_CODE_AGENT_OPTIONS_SOURCE, readFileSync(CLAUDE_CODE_AGENT_OPTIONS_SOURCE, "utf8")],
    [CODEX_AGENT_OPTIONS_SOURCE, readFileSync(CODEX_AGENT_OPTIONS_SOURCE, "utf8")],
    [KIMI_AGENT_OPTIONS_SOURCE, readFileSync(KIMI_AGENT_OPTIONS_SOURCE, "utf8")],
    [AMP_AGENT_OPTIONS_SOURCE, readFileSync(AMP_AGENT_OPTIONS_SOURCE, "utf8")],
    [join(root, "docs/agents/codex.mdx"), readFileSync(join(root, "docs/agents/codex.mdx"), "utf8")],
  ]);
  const required = [
    [MCP_INTEGRATION_EXAMPLE_README, "**CLI agents** consume MCP"],
    [MCP_INTEGRATION_EXAMPLE_README, "Claude Code, Kimi,\nand Amp expose MCP config flags"],
    [MCP_INTEGRATION_EXAMPLE_README, "Codex reads MCP servers from\n`~/.codex/config.toml` or `codex mcp add`"],
    [CLAUDE_CODE_AGENT_OPTIONS_SOURCE, "mcpConfig?: string[];"],
    [KIMI_AGENT_OPTIONS_SOURCE, "mcpConfig?: string[];"],
    [AMP_AGENT_OPTIONS_SOURCE, "mcpConfig?: string;"],
    [join(root, "docs/agents/codex.mdx"), "[mcp_servers.smithers]"],
    [join(root, "docs/agents/codex.mdx"), "codex mcp add smithers -- bunx smithers-orchestrator --mcp"],
  ];
  const forbidden = [
    [MCP_INTEGRATION_EXAMPLE_README, "Claude Code,\nCodex, Kimi) consume MCP differently"],
    [MCP_INTEGRATION_EXAMPLE_README, "Codex, Kimi) consume MCP differently"],
    [MCP_INTEGRATION_EXAMPLE_README, "they take an `.mcp.json` config file via\nflags like `--mcp-config`"],
    [CODEX_AGENT_OPTIONS_SOURCE, "mcpConfig"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ MCP integration docs must match current CLI-agent MCP option surfaces:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ MCP integration docs match current CLI-agent MCP option surfaces");
  }
}

function checkMcpToolsetDocsMatchPackageSurface() {
  const files = new Map([
    [MCP_TOOLSET_INTEGRATION, readFileSync(MCP_TOOLSET_INTEGRATION, "utf8")],
    [INTEGRATIONS_OVERVIEW, readFileSync(INTEGRATIONS_OVERVIEW, "utf8")],
    [DOCS_CONFIG, readFileSync(DOCS_CONFIG, "utf8")],
    [GENERATE_LLMS_SCRIPT, readFileSync(GENERATE_LLMS_SCRIPT, "utf8")],
    [AGENTS_PACKAGE_JSON, readFileSync(AGENTS_PACKAGE_JSON, "utf8")],
    [MCP_CREATE_TOOLSET_SOURCE, readFileSync(MCP_CREATE_TOOLSET_SOURCE, "utf8")],
    [MCP_CREATE_TOOLSET_DECLARATION, readFileSync(MCP_CREATE_TOOLSET_DECLARATION, "utf8")],
    [MCP_SERVER_CONFIG_SOURCE, readFileSync(MCP_SERVER_CONFIG_SOURCE, "utf8")],
    [MCP_TOOLSET_SOURCE, readFileSync(MCP_TOOLSET_SOURCE, "utf8")],
    [MCP_TOOLSET_OPTIONS_SOURCE, readFileSync(MCP_TOOLSET_OPTIONS_SOURCE, "utf8")],
  ]);
  const required = [
    [MCP_CREATE_TOOLSET_SOURCE, 'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";'],
    [MCP_CREATE_TOOLSET_SOURCE, 'import { dynamicTool, jsonSchema } from "ai";'],
    [MCP_CREATE_TOOLSET_SOURCE, 'import("./McpToolsetOptions.ts").McpToolsetOptions'],
    [MCP_CREATE_TOOLSET_SOURCE, "export async function createMcpToolset(config, options = {})"],
    [MCP_CREATE_TOOLSET_SOURCE, "command: config.command"],
    [MCP_CREATE_TOOLSET_SOURCE, "args: config.args ?? []"],
    [MCP_CREATE_TOOLSET_SOURCE, "...(config.env ? { env: config.env } : {})"],
    [MCP_CREATE_TOOLSET_SOURCE, "...(config.cwd ? { cwd: config.cwd } : {})"],
    [MCP_CREATE_TOOLSET_SOURCE, 'options.clientName ?? "smithers-mcp-toolset"'],
    [MCP_CREATE_TOOLSET_SOURCE, 'options.clientVersion ?? "0.0.0"'],
    [MCP_CREATE_TOOLSET_SOURCE, "const listed = await client.listTools();"],
    [MCP_CREATE_TOOLSET_SOURCE, "if (options.include && !options.include.includes(mcpTool.name)) continue;"],
    [MCP_CREATE_TOOLSET_SOURCE, "if (options.exclude && options.exclude.includes(mcpTool.name)) continue;"],
    [MCP_CREATE_TOOLSET_SOURCE, "tools[`${prefix}${mcpTool.name}`]"],
    [MCP_CREATE_TOOLSET_SOURCE, "dynamicTool({"],
    [MCP_CREATE_TOOLSET_SOURCE, "jsonSchema("],
    [MCP_CREATE_TOOLSET_SOURCE, "const result = await client.callTool({"],
    [MCP_CREATE_TOOLSET_SOURCE, "return { error: true, message: text ||"],
    [MCP_CREATE_TOOLSET_SOURCE, "return result.structuredContent ?? text;"],
    [MCP_SERVER_CONFIG_SOURCE, "export type McpServerConfig ="],
    [MCP_SERVER_CONFIG_SOURCE, "command: string;"],
    [MCP_SERVER_CONFIG_SOURCE, "args?: string[];"],
    [MCP_SERVER_CONFIG_SOURCE, "env?: Record<string, string>;"],
    [MCP_SERVER_CONFIG_SOURCE, "cwd?: string;"],
    [MCP_TOOLSET_OPTIONS_SOURCE, "export type McpToolsetOptions ="],
    [MCP_TOOLSET_OPTIONS_SOURCE, "include?: string[];"],
    [MCP_TOOLSET_OPTIONS_SOURCE, "exclude?: string[];"],
    [MCP_TOOLSET_OPTIONS_SOURCE, "namePrefix?: string;"],
    [MCP_TOOLSET_OPTIONS_SOURCE, "clientName?: string;"],
    [MCP_TOOLSET_OPTIONS_SOURCE, "clientVersion?: string;"],
    [MCP_TOOLSET_SOURCE, "tools: Record<string, Tool>;"],
    [MCP_TOOLSET_SOURCE, "toolNames: string[];"],
    [MCP_TOOLSET_SOURCE, "close: () => Promise<void>;"],
    [MCP_CREATE_TOOLSET_DECLARATION, "export type { McpServerConfig }"],
    [MCP_CREATE_TOOLSET_DECLARATION, "export type { McpToolset }"],
    [MCP_CREATE_TOOLSET_DECLARATION, "export type { McpToolsetOptions }"],
    [MCP_CREATE_TOOLSET_DECLARATION, "export declare function createMcpToolset("],
    [MCP_CREATE_TOOLSET_DECLARATION, "options?: McpToolsetOptions"],
    [MCP_CREATE_TOOLSET_DECLARATION, "): Promise<McpToolset>;"],
    [MCP_TOOLSET_INTEGRATION, 'from "@smithers-orchestrator/agents/mcp/createMcpToolset";'],
    [MCP_TOOLSET_INTEGRATION, "it is not re-exported from the top-level `smithers-orchestrator` facade"],
    [MCP_TOOLSET_INTEGRATION, "Call `close()` in a `finally` block"],
    [MCP_TOOLSET_INTEGRATION, "type McpServerConfig = {"],
    [MCP_TOOLSET_INTEGRATION, "command: string;"],
    [MCP_TOOLSET_INTEGRATION, "env?: Record<string, string>;"],
    [MCP_TOOLSET_INTEGRATION, "type McpToolsetOptions = {"],
    [MCP_TOOLSET_INTEGRATION, "include?: string[];"],
    [MCP_TOOLSET_INTEGRATION, "exclude?: string[];"],
    [MCP_TOOLSET_INTEGRATION, "namePrefix?: string;"],
    [MCP_TOOLSET_INTEGRATION, "clientName?: string;"],
    [MCP_TOOLSET_INTEGRATION, "clientVersion?: string;"],
    [MCP_TOOLSET_INTEGRATION, "type McpToolset = {"],
    [MCP_TOOLSET_INTEGRATION, "tools: Record<string, import(\"ai\").Tool>;"],
    [MCP_TOOLSET_INTEGRATION, "toolNames: string[];"],
    [MCP_TOOLSET_INTEGRATION, "close: () => Promise<void>;"],
    [MCP_TOOLSET_INTEGRATION, 'clientName: "smithers-mcp-toolset"'],
    [MCP_TOOLSET_INTEGRATION, 'clientVersion: "0.0.0"'],
    [MCP_TOOLSET_INTEGRATION, "`include` and `exclude` match the original MCP server tool names before `namePrefix` is applied"],
    [MCP_TOOLSET_INTEGRATION, "If both match a tool, `exclude` wins."],
    [MCP_TOOLSET_INTEGRATION, "`toolNames` contains the final names after filtering and prefixing"],
    [MCP_TOOLSET_INTEGRATION, "calls `tools/list` once"],
    [MCP_TOOLSET_INTEGRATION, "calls MCP `tools/call`"],
    [MCP_TOOLSET_INTEGRATION, "return `structuredContent`"],
    [MCP_TOOLSET_INTEGRATION, '{ error: true, message, status: "failed" }'],
    [MCP_TOOLSET_INTEGRATION, "empty object JSON schema"],
    [MCP_TOOLSET_INTEGRATION, "CLI agents consume MCP through their native configuration surfaces, not through `createMcpToolset`."],
    [INTEGRATIONS_OVERVIEW, "[MCP Toolset](/integrations/mcp-toolset) turns that server into AI SDK tools"],
    [DOCS_CONFIG, '"integrations/mcp-toolset"'],
    [GENERATE_LLMS_SCRIPT, '"integrations/mcp-toolset.mdx"'],
  ];
  const forbidden = [
    [MCP_TOOLSET_INTEGRATION, 'import { createMcpToolset } from "smithers-orchestrator";'],
    [MCP_TOOLSET_INTEGRATION, "does not need `close()`"],
    [MCP_TOOLSET_INTEGRATION, "CLI agents consume MCP through `createMcpToolset`"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  const problems = [];

  try {
    const agentsPackage = JSON.parse(files.get(AGENTS_PACKAGE_JSON));
    const exportEntry = agentsPackage.exports?.["./mcp/createMcpToolset"];
    if (!exportEntry) {
      problems.push("packages/agents/package.json missing ./mcp/createMcpToolset export");
    } else {
      if (exportEntry.types !== "./src/mcp/createMcpToolset.d.ts") {
        problems.push("./mcp/createMcpToolset export must point types at ./src/mcp/createMcpToolset.d.ts");
      }
      if (exportEntry.import !== "./src/mcp/createMcpToolset.js") {
        problems.push("./mcp/createMcpToolset export must point import at ./src/mcp/createMcpToolset.js");
      }
      if (exportEntry.default !== "./src/mcp/createMcpToolset.js") {
        problems.push("./mcp/createMcpToolset export must point default at ./src/mcp/createMcpToolset.js");
      }
    }
  } catch (error) {
    problems.push(`could not parse packages/agents/package.json: ${error.message}`);
  }

  if (missing.length || stale.length || problems.length) {
    failed = true;
    console.error("\n✗ MCP toolset docs must match the package export, source types, and runtime behavior:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (problems.length) console.error(`    ${problems.join("\n    ")}`);
  } else {
    console.log("✓ MCP toolset docs match the package export, source types, and runtime behavior");
  }
}

function checkMcpSemanticDocsMatchSchemas() {
  const docs = readFileSync(join(root, "docs/integrations/mcp-server.mdx"), "utf8");
  const semanticTools = readFileSync(MCP_SEMANTIC_TOOLS_SOURCE, "utf8");
  const nodeDetailSource = readFileSync(join(root, "apps/cli/src/node-detail.js"), "utf8");
  const docsScopeOccurrences = docs.split('scope: "local" | "global";').length - 1;
  const docsPathOccurrences = docs.split("path: string;").length - 1;
  const required = [
    [MCP_SEMANTIC_TOOLS_SOURCE, 'scope: z.enum(["local", "global"])'],
    [MCP_SEMANTIC_TOOLS_SOURCE, "path: z.string()"],
    [MCP_SEMANTIC_TOOLS_SOURCE, "scope: discovered.scope"],
    [MCP_SEMANTIC_TOOLS_SOURCE, "path: discovered.path"],
    [MCP_SEMANTIC_TOOLS_SOURCE, "approval: pendingApprovalSchema.nullable().optional()"],
    [join(root, "apps/cli/src/node-detail.js"), "approval: approvalRow"],
  ];
  const forbidden = [
    [MCP_SEMANTIC_TOOLS_SOURCE, "entryFile: discovered.entryFile,\n            sourceType: discovered.sourceType"],
  ];
  const stale = forbidden.filter(([, needle]) => semanticTools.includes(needle));
  const problems = [];
  if (docsScopeOccurrences < 2) {
    problems.push(`docs/integrations/mcp-server.mdx:scope documented ${docsScopeOccurrences} time(s), expected at least 2`);
  }
  if (docsPathOccurrences < 2) {
    problems.push(`docs/integrations/mcp-server.mdx:path documented ${docsPathOccurrences} time(s), expected at least 2`);
  }
  if (!docs.includes("approval: PendingApproval | null;")) {
    problems.push("docs/integrations/mcp-server.mdx:get_node_detail output must document detail.approval");
  }
  const missingFromSource = required.filter(([file, needle]) => {
    const source = file === MCP_SEMANTIC_TOOLS_SOURCE ? semanticTools : nodeDetailSource;
    return !source.includes(needle);
  });
  if (missingFromSource.length || stale.length || problems.length) {
    failed = true;
    console.error("\n✗ MCP semantic docs must match the Zod schemas and runtime output:");
    if (missingFromSource.length) {
      console.error(
        `    missing: ${missingFromSource.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (problems.length) console.error(`    ${problems.join("\n    ")}`);
  } else {
    console.log("✓ MCP semantic docs match the source schemas");
  }
}

function checkSdkAgentDocsMatchSourceTypes() {
  const files = new Map([
    [SDK_AGENTS_INTEGRATION, readFileSync(SDK_AGENTS_INTEGRATION, "utf8")],
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [RECIPES_DOC, readFileSync(RECIPES_DOC, "utf8")],
    [SDK_AGENT_OPTIONS_SOURCE, readFileSync(SDK_AGENT_OPTIONS_SOURCE, "utf8")],
    [ANTHROPIC_AGENT_OPTIONS_SOURCE, readFileSync(ANTHROPIC_AGENT_OPTIONS_SOURCE, "utf8")],
    [OPENAI_AGENT_OPTIONS_SOURCE, readFileSync(OPENAI_AGENT_OPTIONS_SOURCE, "utf8")],
    [HERMES_AGENT_OPTIONS_SOURCE, readFileSync(HERMES_AGENT_OPTIONS_SOURCE, "utf8")],
    [OPENAI_AGENT_SOURCE, readFileSync(OPENAI_AGENT_SOURCE, "utf8")],
    [HERMES_AGENT_SOURCE, readFileSync(HERMES_AGENT_SOURCE, "utf8")],
  ]);
  const required = [
    [SDK_AGENT_OPTIONS_SOURCE, "model: string | MODEL;"],
    [SDK_AGENT_OPTIONS_SOURCE, "ToolLoopAgentSettings"],
    [SDK_AGENT_OPTIONS_SOURCE, "Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, \"model\">"],
    [ANTHROPIC_AGENT_OPTIONS_SOURCE, "SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>"],
    [OPENAI_AGENT_OPTIONS_SOURCE, "nativeStructuredOutput?: boolean;"],
    [OPENAI_AGENT_OPTIONS_SOURCE, "baseURL?: never;"],
    [OPENAI_AGENT_OPTIONS_SOURCE, "apiKey?: never;"],
    [OPENAI_AGENT_SOURCE, "OpenAIAgent baseURL/apiKey can only be used when model is a string"],
    [HERMES_AGENT_OPTIONS_SOURCE, "model?: string;"],
    [HERMES_AGENT_OPTIONS_SOURCE, "baseURL?: string;"],
    [HERMES_AGENT_OPTIONS_SOURCE, "apiKey?: string;"],
    [HERMES_AGENT_OPTIONS_SOURCE, "nativeStructuredOutput?: boolean;"],
    [HERMES_AGENT_SOURCE, 'model = "hermes"'],
    [HERMES_AGENT_SOURCE, "baseURL = process.env.HERMES_BASE_URL"],
    [HERMES_AGENT_SOURCE, 'apiKey = process.env.HERMES_API_KEY ?? "hermes"'],
    [HERMES_AGENT_SOURCE, "nativeStructuredOutput = false"],
    [SDK_AGENTS_INTEGRATION, "Provider-backed AI SDK agent wrappers for Anthropic, OpenAI, and Hermes"],
    [SDK_AGENTS_INTEGRATION, "`AnthropicAgent`, `OpenAIAgent`, and `HermesAgent` are provider-backed"],
    [SDK_AGENTS_INTEGRATION, "`OpenAIAgentOptions` adds `nativeStructuredOutput?: boolean`"],
    [SDK_AGENTS_INTEGRATION, "a prebuilt OpenAI provider model must not include `baseURL` or `apiKey`"],
    [SDK_AGENTS_INTEGRATION, "`HermesAgentOptions` makes `model` optional"],
    [SDK_AGENTS_INTEGRATION, "A runtime `baseURL` or `HERMES_BASE_URL` is required"],
    [SDK_AGENTS_INTEGRATION, "`baseURL` falls back to the `HERMES_BASE_URL` env var and must be set in either place"],
    [TYPES_REFERENCE, "type SdkAgentOptions<CALL_OPTIONS = never, TOOLS extends import(\"ai\").ToolSet = {}, MODEL = any> ="],
    [TYPES_REFERENCE, "type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS extends import(\"ai\").ToolSet = {}> ="],
    [TYPES_REFERENCE, "type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS extends import(\"ai\").ToolSet = {}> ="],
    [TYPES_REFERENCE, "| { model: ReturnType<typeof import(\"@ai-sdk/openai\").openai>; baseURL?: never; apiKey?: never }"],
    [TYPES_REFERENCE, "type HermesAgentOptions<CALL_OPTIONS = never, TOOLS extends import(\"ai\").ToolSet = {}> ="],
    [TYPES_REFERENCE, "baseURL?: string;               // falls back to HERMES_BASE_URL; required at runtime"],
    [TYPES_REFERENCE, "nativeStructuredOutput?: boolean; // default false"],
    [RECIPES_DOC, 'new AnthropicAgent({ model, instructions: "Return JSON" })'],
    [RECIPES_DOC, 'new AnthropicAgent({ model, instructions: "...", tools: { read, grep } })'],
    [RECIPES_DOC, 'new AnthropicAgent({ model, instructions: "...", tools: { read, write, edit, bash } })'],
  ];
  const forbidden = [
    [SDK_AGENTS_INTEGRATION, "Provider-backed AI SDK agent wrappers for Anthropic and OpenAI"],
    [SDK_AGENTS_INTEGRATION, "`AnthropicAgent` and `OpenAIAgent` are thin wrappers"],
    [SDK_AGENTS_INTEGRATION, "Both classes accept a model ID string"],
    [SDK_AGENTS_INTEGRATION, "in that form, `apiKey: \"none\"` belongs in the `createOpenAI` config"],
    [RECIPES_DOC, "new AnthropicAgent({ model, system:"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ SDK agent docs must match current public option types and constructor behavior:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ SDK agent docs match current option types and constructor behavior");
  }
}

function checkCliAgentDocsMatchCurrentModelDefaults() {
  const files = new Map([
    [CLI_AGENTS_INTEGRATION, readFileSync(CLI_AGENTS_INTEGRATION, "utf8")],
    [CLI_AGENT_AVAILABILITY_TYPE, readFileSync(CLI_AGENT_AVAILABILITY_TYPE, "utf8")],
    [CLI_AGENT_DETECTION_SOURCE, readFileSync(CLI_AGENT_DETECTION_SOURCE, "utf8")],
    [BASE_CLI_AGENT_SOURCE, readFileSync(BASE_CLI_AGENT_SOURCE, "utf8")],
  ]);
  const required = [
    [BASE_CLI_AGENT_SOURCE, "this.model = opts.model;"],
    [CLI_AGENTS_INTEGRATION, "agents[10]{class,cli,modelDefault,hijack,notes}:"],
    [CLI_AGENTS_INTEGRATION, "ClaudeCodeAgent,claude,CLI default,native session id"],
    [CLI_AGENTS_INTEGRATION, "CodexAgent,codex,CLI default,native thread id"],
    [CLI_AGENTS_INTEGRATION, "PiAgent,pi,CLI default,native session id"],
    [CLI_AGENTS_INTEGRATION, "KimiAgent,kimi,CLI default,native session id"],
    [CLI_AGENTS_INTEGRATION, "ForgeAgent,forge,CLI default,conversation id"],
    [CLI_AGENTS_INTEGRATION, "AmpAgent,amp,CLI default,thread id"],
    [CLI_AGENTS_INTEGRATION, "VibeAgent,vibe,CLI default,headless session id"],
    [CLI_AGENTS_INTEGRATION, "OpenCodeAgent,opencode,CLI default,not yet"],
    [CLI_AGENT_DETECTION_SOURCE, 'id: "vibe"'],
    [CLI_AGENT_AVAILABILITY_TYPE, '"vibe"'],
  ];
  const forbidden = [
    [CLI_AGENTS_INTEGRATION, "agents[10]{class,cli,defaultModel,hijack,notes}:"],
    [CLI_AGENTS_INTEGRATION, "ClaudeCodeAgent,claude,claude-sonnet-4-20250514,"],
    [CLI_AGENTS_INTEGRATION, "CodexAgent,codex,gpt-5.3-codex,"],
    [CLI_AGENTS_INTEGRATION, "PiAgent,pi,gpt-5.2-codex,"],
    [CLI_AGENTS_INTEGRATION, "KimiAgent,kimi,kimi-latest,"],
    [CLI_AGENTS_INTEGRATION, "ForgeAgent,forge,anthropic/claude-sonnet-4-20250514,"],
    [CLI_AGENTS_INTEGRATION, "AmpAgent,amp,claude-sonnet-4-20250514,"],
    [CLI_AGENTS_INTEGRATION, "VibeAgent,vibe,mistral-large-latest,"],
    [CLI_AGENTS_INTEGRATION, "OpenCodeAgent,opencode,provider/model string,"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ CLI agent docs must not claim Smithers-owned model defaults:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ CLI agent docs match current model default behavior");
  }
}

function checkCliAgentHijackDocsMatchLauncher() {
  const files = new Map([
    [CLI_AGENTS_INTEGRATION, readFileSync(CLI_AGENTS_INTEGRATION, "utf8")],
    [CLI_HIJACK_SOURCE, readFileSync(CLI_HIJACK_SOURCE, "utf8")],
    [NATIVE_HIJACK_ENGINE_SOURCE, readFileSync(NATIVE_HIJACK_ENGINE_SOURCE, "utf8")],
  ]);
  const required = [
    [NATIVE_HIJACK_ENGINE_SOURCE, '| "gemini"'],
    [CLI_HIJACK_SOURCE, 'candidate.engine === "gemini"'],
    [CLI_HIJACK_SOURCE, 'command: "gemini"'],
    [CLI_HIJACK_SOURCE, 'args: ["--resume", candidate.resume]'],
    [CLI_AGENTS_INTEGRATION, "| `ClaudeCodeAgent` | `claude --resume` |"],
    [CLI_AGENTS_INTEGRATION, "| `CodexAgent` | `codex resume` |"],
    [CLI_AGENTS_INTEGRATION, "| `AntigravityAgent` | `agy --conversation` |"],
    [CLI_AGENTS_INTEGRATION, "| `GeminiAgent` | `gemini --resume` |"],
    [CLI_AGENTS_INTEGRATION, "| `PiAgent` | `pi --session` |"],
    [CLI_AGENTS_INTEGRATION, "| `KimiAgent` | `kimi --session` |"],
    [CLI_AGENTS_INTEGRATION, "| `ForgeAgent` | `forge --conversation-id` |"],
    [CLI_AGENTS_INTEGRATION, "| `AmpAgent` | `amp threads continue` |"],
    [CLI_AGENTS_INTEGRATION, "native `bunx smithers-orchestrator hijack` support for Vibe and OpenCode is not shipped yet"],
  ];
  const forbidden = [
    [CLI_AGENTS_INTEGRATION, "| `VibeAgent` | `vibe --resume` |"],
    [CLI_AGENTS_INTEGRATION, "| `OpenCodeAgent` | `opencode --session` |"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ CLI agent hijack docs must match the native launcher:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ CLI agent hijack docs match the native launcher");
  }
}

function checkCliAgentOptionDocsMatchSourceTypes() {
  const files = new Map([
    [TYPES_REFERENCE, readFileSync(TYPES_REFERENCE, "utf8")],
    [CLI_AGENTS_INTEGRATION, readFileSync(CLI_AGENTS_INTEGRATION, "utf8")],
    [BASE_CLI_AGENT_OPTIONS_SOURCE, readFileSync(BASE_CLI_AGENT_OPTIONS_SOURCE, "utf8")],
    [PI_AGENT_OPTIONS_SOURCE, readFileSync(PI_AGENT_OPTIONS_SOURCE, "utf8")],
    [PI_EXTENSION_UI_REQUEST_SOURCE, readFileSync(PI_EXTENSION_UI_REQUEST_SOURCE, "utf8")],
    [PI_EXTENSION_UI_RESPONSE_SOURCE, readFileSync(PI_EXTENSION_UI_RESPONSE_SOURCE, "utf8")],
    [PI_AGENT_SOURCE, readFileSync(PI_AGENT_SOURCE, "utf8")],
    [VIBE_AGENT_OPTIONS_SOURCE, readFileSync(VIBE_AGENT_OPTIONS_SOURCE, "utf8")],
    [OPENCODE_AGENT_SOURCE, readFileSync(OPENCODE_AGENT_SOURCE, "utf8")],
  ]);
  const required = [
    [BASE_CLI_AGENT_OPTIONS_SOURCE, "export type BaseCliAgentOptions = {"],
    [BASE_CLI_AGENT_OPTIONS_SOURCE, "extraArgs?: string[];"],
    [TYPES_REFERENCE, "type BaseCliAgentOptions = {"],
    [TYPES_REFERENCE, "extraArgs?: string[];"],
    [PI_AGENT_OPTIONS_SOURCE, "export type PiAgentOptions = BaseCliAgentOptions & {"],
    [PI_AGENT_OPTIONS_SOURCE, "model?: string;"],
    [PI_AGENT_OPTIONS_SOURCE, "systemPrompt?: string;"],
    [PI_AGENT_OPTIONS_SOURCE, 'mode?: "text" | "json" | "rpc";'],
    [PI_EXTENSION_UI_REQUEST_SOURCE, 'type: "extension_ui_request";'],
    [PI_EXTENSION_UI_REQUEST_SOURCE, "[key: string]: unknown;"],
    [PI_EXTENSION_UI_RESPONSE_SOURCE, 'type: "extension_ui_response";'],
    [PI_EXTENSION_UI_RESPONSE_SOURCE, "cancelled?: boolean;"],
    [PI_AGENT_SOURCE, 'pushFlag(args, "--model", this.opts.model ?? this.model);'],
    [TYPES_REFERENCE, "type PiAgentOptions = BaseCliAgentOptions & {"],
    [TYPES_REFERENCE, "systemPrompt?: string;"],
    [TYPES_REFERENCE, 'mode?: "text" | "json" | "rpc";'],
    [TYPES_REFERENCE, "onExtensionUiRequest?: ("],
    [TYPES_REFERENCE, "type PiExtensionUiRequest = {"],
    [TYPES_REFERENCE, 'type: "extension_ui_request";'],
    [TYPES_REFERENCE, "type PiExtensionUiResponse = {"],
    [TYPES_REFERENCE, "cancelled?: boolean;"],
    [CLI_AGENTS_INTEGRATION, "Key additions: `provider`, `model`, `mode`, `onExtensionUiRequest`, `extension`, `thinking`."],
    [CLI_AGENTS_INTEGRATION, 'provider?: string; model?: string; apiKey?: string; appendSystemPrompt?: string; mode?: "text" | "json" | "rpc";'],
    [VIBE_AGENT_OPTIONS_SOURCE, "export type VibeAgentOptions = BaseCliAgentOptions & {"],
    [VIBE_AGENT_OPTIONS_SOURCE, "enabledTools?: string[];"],
    [VIBE_AGENT_OPTIONS_SOURCE, "continueSession?: boolean;"],
    [TYPES_REFERENCE, "type VibeAgentOptions = BaseCliAgentOptions & {"],
    [TYPES_REFERENCE, "enabledTools?: string[];"],
    [TYPES_REFERENCE, "sessionId?: string;"],
    [TYPES_REFERENCE, "continueSession?: boolean;"],
    [CLI_AGENTS_INTEGRATION, "Key additions: `agent`, `maxTurns`, `maxPrice`, `maxTokens`, `enabledTools`, `sessionId`, `continueSession`."],
    [CLI_AGENTS_INTEGRATION, "enabledTools?: string[];"],
    [CLI_AGENTS_INTEGRATION, "sessionId?: string; continueSession?: boolean;"],
    [OPENCODE_AGENT_SOURCE, "export type OpenCodeAgentOptions = BaseCliAgentOptions & {"],
    [OPENCODE_AGENT_SOURCE, "attachFiles?: string[];"],
    [OPENCODE_AGENT_SOURCE, "variant?: string;"],
    [TYPES_REFERENCE, "type OpenCodeAgentOptions = BaseCliAgentOptions & {"],
    [TYPES_REFERENCE, "attachFiles?: string[];"],
    [TYPES_REFERENCE, "variant?: string;"],
  ];
  const forbidden = [
    [CLI_AGENTS_INTEGRATION, "Key additions: `mode`, `onExtensionUiRequest`, `extension`, `thinking`."],
    [CLI_AGENTS_INTEGRATION, 'provider?: string; apiKey?: string; appendSystemPrompt?: string; mode?: "text" | "json" | "rpc";'],
    [TYPES_REFERENCE, "type PiAgentOptions = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type VibeAgentOptions = Record<string, unknown>;"],
    [TYPES_REFERENCE, "type OpenCodeAgentOptions = Record<string, unknown>;"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ CLI agent option docs must match source option types:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ CLI agent option docs match source option types");
  }
}

function checkGatewaySdkDocsMatchExports() {
  const gatewayServerSource = join(root, "packages/server/src/gateway.js");
  const files = new Map([
    [GATEWAY_INTEGRATION, readFileSync(GATEWAY_INTEGRATION, "utf8")],
    [CUSTOM_UI_INTEGRATION, readFileSync(CUSTOM_UI_INTEGRATION, "utf8")],
    [CUSTOM_WORKFLOW_UI_GUIDE, readFileSync(CUSTOM_WORKFLOW_UI_GUIDE, "utf8")],
    [SMITHERS_WORKER_SOURCE, readFileSync(SMITHERS_WORKER_SOURCE, "utf8")],
    [SMITHERS_GATEWAY_CLIENT_WRAPPER_SOURCE, readFileSync(SMITHERS_GATEWAY_CLIENT_WRAPPER_SOURCE, "utf8")],
    [gatewayServerSource, readFileSync(gatewayServerSource, "utf8")],
    [GATEWAY_CLIENT_INDEX, readFileSync(GATEWAY_CLIENT_INDEX, "utf8")],
    [GATEWAY_CLIENT_SOURCE, readFileSync(GATEWAY_CLIENT_SOURCE, "utf8")],
    [GATEWAY_CLIENT_RPC_TYPE_MAP, readFileSync(GATEWAY_CLIENT_RPC_TYPE_MAP, "utf8")],
    [GATEWAY_REACT_INDEX, readFileSync(GATEWAY_REACT_INDEX, "utf8")],
    [GATEWAY_REACT_ASYNC_STATE, readFileSync(GATEWAY_REACT_ASYNC_STATE, "utf8")],
    [GATEWAY_REACT_USE_GATEWAY_RUN, readFileSync(GATEWAY_REACT_USE_GATEWAY_RUN, "utf8")],
    [GATEWAY_REACT_USE_GATEWAY_RPC, readFileSync(GATEWAY_REACT_USE_GATEWAY_RPC, "utf8")],
    [GATEWAY_REACT_USE_GATEWAY_NODE_OUTPUT, readFileSync(GATEWAY_REACT_USE_GATEWAY_NODE_OUTPUT, "utf8")],
  ]);
  const required = [
    [GATEWAY_CLIENT_INDEX, 'export { createGatewayCollection, type GatewayCollectionConfig } from "./sync/createGatewayCollection.ts";'],
    [GATEWAY_CLIENT_INDEX, 'export { gatewayKeys } from "./sync/gatewayKeys.ts";'],
    [GATEWAY_CLIENT_INDEX, "createSmithersGatewayTransport"],
    [GATEWAY_CLIENT_INDEX, "GatewayExtensionStreamFrame"],
    [GATEWAY_CLIENT_RPC_TYPE_MAP, "listRuns: Array<Record<string, unknown>>;"],
    [GATEWAY_CLIENT_RPC_TYPE_MAP, "listWorkflows: ListWorkflowsResponse;"],
    [GATEWAY_CLIENT_RPC_TYPE_MAP, "listApprovals: ListApprovalsResponse;"],
    [GATEWAY_CLIENT_RPC_TYPE_MAP, "getNodeOutput: Record<string, unknown>;"],
    [GATEWAY_CLIENT_SOURCE, "async *streamDevTools("],
    [GATEWAY_CLIENT_SOURCE, 'const subscribed = await connection.request("streamDevTools", params);'],
    [SMITHERS_WORKER_SOURCE, "const token = gatewayAuthToken(env);"],
    [SMITHERS_WORKER_SOURCE, "addGatewayCredential(headers, token);"],
    [SMITHERS_WORKER_SOURCE, "return proxyWithHeaders(request, base, headers);"],
    [SMITHERS_WORKER_SOURCE, "addTrustedProxyHeaders(headers, validation.user, env);"],
    [SMITHERS_GATEWAY_CLIENT_WRAPPER_SOURCE, 'const RPC_WS_PATH = "/v1/rpc";'],
    [SMITHERS_GATEWAY_CLIENT_WRAPPER_SOURCE, "WebSocket: RpcPathWebSocket,"],
    [gatewayServerSource, 'if (this.auth.mode === "token") {'],
    [gatewayServerSource, 'if (this.auth.mode === "trusted-proxy") {'],
    [gatewayServerSource, 'rpcPath: "/v1/rpc",'],
    [gatewayServerSource, 'wsPath: "/",'],
    [GATEWAY_CLIENT_SOURCE, "this.boot = globalThis.__SMITHERS_GATEWAY_UI__;"],
    [GATEWAY_CLIENT_SOURCE, "options: { signal?: AbortSignal } = {},"],
    [GATEWAY_CLIENT_SOURCE, 'listRuns(params: GatewayRpcParams<"listRuns"> = {}) {'],
    [GATEWAY_CLIENT_SOURCE, 'headers.set("authorization", `Bearer ${options.token}`);'],
    [GATEWAY_CLIENT_SOURCE, "...(this.token ? { auth: { token: this.token } } : {}),"],
    [gatewayServerSource, 'return responseError(id, "FORBIDDEN", `Missing required scope ${requiredScope} for ${method}`, {'],
    [gatewayServerSource, "return responseError(id, authResult.code, authResult.message, authResult.details);"],
    [gatewayServerSource, 'refresh: "smithers token issue",'],
    [GATEWAY_CLIENT_SOURCE, "const response = await this.fetchImpl(`${this.baseUrl}/v1/rpc/${method}`, {"],
    [GATEWAY_CLIENT_SOURCE, "new this.WebSocketImpl(toWebSocketUrl(this.baseUrl, this.boot?.wsPath));"],
    [GATEWAY_REACT_INDEX, "useGatewayExtensionResource"],
    [GATEWAY_REACT_INDEX, "useGatewayExtensionAction"],
    [GATEWAY_REACT_INDEX, "useGatewayExtensionStream"],
    [GATEWAY_REACT_INDEX, "SyncProvider"],
    [GATEWAY_REACT_INDEX, "useSyncQuery"],
    [GATEWAY_REACT_INDEX, "useSyncMutation"],
    [GATEWAY_REACT_INDEX, "useSyncSubscription"],
    [GATEWAY_REACT_INDEX, "useGatewayQuery"],
    [GATEWAY_REACT_INDEX, "useGatewayMutation"],
    [GATEWAY_REACT_INDEX, "useGatewayRunStream"],
    [GATEWAY_REACT_ASYNC_STATE, "data: T | undefined;"],
    [GATEWAY_REACT_ASYNC_STATE, "error: Error | undefined;"],
    [GATEWAY_REACT_ASYNC_STATE, "loading: boolean;"],
    [GATEWAY_REACT_ASYNC_STATE, "refetch: () => Promise<void>;"],
    [GATEWAY_REACT_USE_GATEWAY_RUN, "const collection = runId ? registry.run(runId) : undefined;"],
    [GATEWAY_REACT_USE_GATEWAY_RPC, "): GatewayAsyncState<GatewayRpcPayload<Method>>"],
    [GATEWAY_REACT_USE_GATEWAY_NODE_OUTPUT, 'return useGatewayRpc(\n    "getNodeOutput",'],
    [GATEWAY_INTEGRATION, "createGatewayCollection"],
    [GATEWAY_INTEGRATION, "gatewayCollectionDefs"],
    [GATEWAY_INTEGRATION, "createGatewayCollections"],
    [GATEWAY_INTEGRATION, "gatewayKeys"],
    [GATEWAY_INTEGRATION, "createSmithersGatewayTransport"],
    [GATEWAY_INTEGRATION, "useGatewayExtensionResource"],
    [GATEWAY_INTEGRATION, "useGatewayExtensionAction"],
    [GATEWAY_INTEGRATION, "useGatewayExtensionStream"],
    [GATEWAY_INTEGRATION, "SyncProvider"],
    [GATEWAY_INTEGRATION, "useSyncQuery"],
    [GATEWAY_INTEGRATION, "useGatewayRunStream"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "adds context/hooks on top of the same client"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "useGatewayExtensionResource(namespace, key, params?, opts?)"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "useGatewayExtensionAction(namespace, key)"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "useGatewayExtensionStream(namespace, key, params?, opts?)"],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "const run = useGatewayRun(runId);                   // run record + optional runState, refetches when runId changes",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "Its HTTP RPC wrapper calls `/v1/rpc/<method>` under `baseUrl`, while WebSocket streams use the boot `wsPath`.",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "a direct `fetch` target (`rpcPath`)",
    ],
    [CUSTOM_UI_INTEGRATION, 'useGatewayRuns({ filter: { status: "running" } });'],
    [
      CUSTOM_UI_INTEGRATION,
      "HTTP RPC calls go to `/v1/rpc/<method>` under `baseUrl`, and WebSocket streams use the boot `wsPath`",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "For a page hosted elsewhere, there is normally no boot global; pass an explicit `baseUrl` and token.",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "Generic HTTP RPC calls accept an `AbortSignal` through `gateway.rpc`",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "`gateway.rpc(method, params, { signal })` is the generic escape hatch for caller-managed cancellation.",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "Pending HTTP RPCs made through `gateway.rpc` can be aborted by the caller's `AbortSignal`",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "`token` is sent as `Authorization: Bearer ...` on HTTP RPC calls and as `auth: { token }` in the WebSocket `connect` request.",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "Pass `headers` for extra HTTP RPC headers, or `fetch` / `WebSocket` to override the transport defaults",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "`token` is sent as a bearer header on HTTP RPC calls and in the WebSocket `connect` request body.",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      'error.code === "Forbidden" || error.code === "FORBIDDEN"',
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "`code`: `UNAUTHORIZED` / `FORBIDDEN` at the auth gate; some method-level errors use canonical `Unauthorized` / `Forbidden`.",
    ],
    [
      CUSTOM_UI_INTEGRATION,
      '`refresh?: string`: a server hint string; current token and JWT expiry responses use "smithers token issue".',
    ],
    [
      CUSTOM_UI_INTEGRATION,
      "| `UNAUTHORIZED` / `FORBIDDEN` (or canonical `Unauthorized` / `Forbidden`) |",
    ],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayRuns({ filter? })` | `GatewayAsyncState<Record<string, unknown>[]>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayWorkflows()` | `GatewayAsyncState<ListWorkflowsResponse>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayNodeOutput({ runId, nodeId, iteration? })` | `GatewayAsyncState<Record<string, unknown>>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayApprovals({ filter? })` | `GatewayAsyncState<ListApprovalsResponse>`"],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "Beyond standard node output and run events, `streamDevTools` provides the live DevTools tree: an initial snapshot plus `devtools.event` delta frames",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "DevTools observability streams, sample tests, and the same-origin proxy patterns",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "re-subscribe with the last `afterSeq` or use the sync subscription layer on top of `gatewayKeys.devtools(runId)`",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "The Worker has two Gateway-auth branches:",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "If `GATEWAY_AUTH_TOKEN` is set, the Worker strips browser-supplied Gateway credentials and trusted-proxy headers, adds `Authorization: Bearer <service-token>`, and forwards the request without minting user identity headers.",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      'In `mode: "token"` or `mode: "jwt"`, the Gateway reads the bearer credential and ignores trusted-proxy identity headers',
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "gatewayAuthToken` selects the service-token branch",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "The outer `apps/smithers` Gateway client wrapper rewrites WebSocket URLs to `/v1/rpc`, which is why the Vite proxy enables `ws: true` there.",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "Gateway-hosted iframe bundles that call `new SmithersGatewayClient()` directly use the boot `wsPath` (`/` by default)",
    ],
    [
      CUSTOM_WORKFLOW_UI_GUIDE,
      "Stream sockets depend on the client used: the outer app wrapper upgrades via `/v1/rpc`, while plain hosted bundles use the boot `wsPath`.",
    ],
    [CUSTOM_WORKFLOW_UI_GUIDE, "SyncProvider` + `useSyncQuery` / `useSyncMutation` / `useSyncSubscription"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "useGatewayQuery` / `useGatewayMutation` / `useGatewayRunStream"],
  ];
  const forbidden = [
    [CUSTOM_WORKFLOW_UI_GUIDE, "re-exports nothing the client does not"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayRuns({ filter? })` | `{ data: RunSummary[] }`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayWorkflows()` | `{ data: WorkflowSummary[] }`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayNodeOutput({ runId, nodeId, iteration? })` | `{ data: NodeOutputResponse }`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayApprovals({ filter? })` | `{ data: GatewayApprovalSummary[] }`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayRuns({ filter? })` | `GatewayAsyncState<RunSummary[]>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayWorkflows()` | `GatewayAsyncState<WorkflowSummary[]>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayNodeOutput({ runId, nodeId, iteration? })` | `GatewayAsyncState<NodeOutputResponse>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "`useGatewayApprovals({ filter? })` | `GatewayAsyncState<GatewayApprovalSummary[]>`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "dedicated metric streams via DevTools observability channels"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "memory utilization, token counts, and step durations"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "follow the same resilient reconnection mechanics as `streamRunEventsResilient`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "metrics streaming, sample tests"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "the path the Gateway upgrades for the run-event WebSocket"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "the WebSocket upgrades against `/v1/rpc`"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "trusted-proxy headers override the role/scopes"],
    [CUSTOM_WORKFLOW_UI_GUIDE, 'mode: "token"` with the Worker presenting the shared service token) and reads identity from the headers'],
    [CUSTOM_WORKFLOW_UI_GUIDE, "step 2 + 4"],
    [CUSTOM_WORKFLOW_UI_GUIDE, "uses the matching `wsPath` and `rpcPath`"],
    [CUSTOM_UI_INTEGRATION, "workflow-scoped path (typically"],
    [CUSTOM_UI_INTEGRATION, "/v1/ws/<workflow>"],
    [CUSTOM_UI_INTEGRATION, "the boot config is ignored"],
    [CUSTOM_UI_INTEGRATION, "Every request accepts an `AbortSignal`"],
    [CUSTOM_UI_INTEGRATION, "Authorization: Bearer …"],
    [CUSTOM_UI_INTEGRATION, "on every HTTP and WebSocket handshake"],
    [CUSTOM_UI_INTEGRATION, "bearer header on every request, including the WebSocket handshake"],
    [CUSTOM_UI_INTEGRATION, 'if (error instanceof GatewayRpcError && error.code === "Forbidden")'],
    [CUSTOM_UI_INTEGRATION, 'e.g. `"reauth"`'],
    [CUSTOM_UI_INTEGRATION, 'useGatewayRuns({ status: "running" })'],
    [CUSTOM_WORKFLOW_UI_GUIDE, "refetches as the seq advances"],
  ];
  const missing = required.filter(([file, needle]) => !files.get(file)?.includes(needle));
  const stale = forbidden.filter(([file, needle]) => files.get(file)?.includes(needle));
  if (missing.length || stale.length) {
    failed = true;
    console.error("\n✗ Gateway SDK docs must cover current gateway-client and gateway-react exports:");
    if (missing.length) {
      console.error(
        `    missing: ${missing.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
    if (stale.length) {
      console.error(
        `    stale: ${stale.map(([file, needle]) => `${displayPath(file)}:${needle}`).join(", ")}`,
      );
    }
  } else {
    console.log("✓ Gateway SDK docs cover current gateway-client and gateway-react exports");
  }
}

const errorCodes = readErrorDefinitionCodes();
checkErrorReferenceCodes(errorCodes);
checkKnownErrorCodeUnion(errorCodes);
checkGatewayTypeDocs();
checkFacadeDeclarations();
checkDocumentedSmithersImportsMatchFacade();
checkDocumentedPackageImportsResolve();
checkImplementedApisNotMarkedComingSoon();
checkTimerDocsMatchWakeRuntime();
checkIronProxySpecMatchesSandboxSeam();
checkFreestyleDocsMatchProviderSeam();
checkRunStateDocsMatchCurrentEmission();
checkRunStateDocsMatchDerivationContract();
checkGatewayRpcReferenceDocsMatchRegistry();
checkGatewayRpcErrorTableMatchesRegistry();
checkGatewayLegacyErrorAliasDocsMatchStatusMap();
checkGatewayAuthDocsMatchRuntimeDefaults();
checkGatewayGetRunDocsMatchResponseShape();
checkGatewayStreamDevToolsDocsMatchRuntimeShape();
checkGatewayCancelRunDocsMatchRuntimeErrors();
checkGatewaySubmitApprovalDocsMatchRuntimeErrors();
checkHotReloadDocsMatchRuntimeDefaults();
checkRunOptionsDocsMatchSourceType();
checkSmithersWorkflowDocsMatchSourceType();
checkSmithersCtxDocsMatchDriverDeclaration();
checkCreateSmithersPostgresDocsMatchFactory();
checkCreateSmithersApiDocsMatchSourceType();
checkCreateExternalSmithersDocsMatchSourceTypes();
checkAgentAndCacheDocsMatchSourceTypes();
checkAlertingDocsMatchRuntimeSurface();
checkControlPlaneDocsMatchStoreApi();
checkReferenceDeploymentDocsMatchFiles();
checkSandboxDocsMatchProviderTypes();
checkSandboxEgressDocsMatchRuntime();
checkServeDocsMatchServerTypes();
checkHttpServerDocsMatchRuntimeSurface();
checkComponentPropsDocsMatchSourceTypes();
checkTypesReferenceIncludesCompositeComponentProps();
checkPackageConfigurationDocsMatchRootConfig();
checkPiPluginDocsMatchPackageRuntime();
checkVcsHelperDocsMatchCurrentExports();
checkTimeTravelDocsMatchCurrentExports();
checkStudioDocsMatchCurrentAppSurface();
checkCliOverviewCommandCatalogMatchesCli();
checkCliOverviewWorkflowRunFlagsMatchSchema();
checkToolDocsMatchCurrentRuntimeLogging();
checkToolDocsMatchRuntimeLimitsAndNetwork();
checkMemoryDocsMatchSourceTypes();
checkScorerDocsMatchSourceTypes();
checkOpenApiDocsMatchCurrentPackage();
checkMcpIntegrationDocsMatchAgentOptions();
checkMcpToolsetDocsMatchPackageSurface();
checkMcpSemanticDocsMatchSchemas();
checkSdkAgentDocsMatchSourceTypes();
checkCliAgentDocsMatchCurrentModelDefaults();
checkCliAgentHijackDocsMatchLauncher();
checkCliAgentOptionDocsMatchSourceTypes();
checkGatewaySdkDocsMatchExports();

process.exit(failed ? 1 : 0);
