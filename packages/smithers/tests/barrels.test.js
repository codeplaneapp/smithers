import { describe, expect, test } from "bun:test";

// Each of these public subpath entrypoints is a thin re-export barrel over a
// sibling workspace package. Importing them here evaluates the `export *` /
// `export { ... }` lines (so they count as covered) and, more importantly,
// asserts the published surface actually resolves: a barrel that silently
// dropped a re-export, or pointed at a renamed package export, would fail here.

async function importBarrel(path) {
  const mod = await import(path);
  return mod;
}

describe("public re-export barrels", () => {
  test("sandbox-provider barrels re-export their provider ids and factories", async () => {
    const aws = await importBarrel("../src/aws.js");
    expect(aws.AWS_SANDBOX_PROVIDER_ID).toBe("aws-sandbox");
    expect(typeof aws.createAwsSandboxProvider).toBe("function");
    expect(typeof aws.registerAwsSandboxProvider).toBe("function");

    const daytona = await importBarrel("../src/daytona.js");
    expect(daytona.DAYTONA_SANDBOX_PROVIDER_ID).toBe("daytona-sandbox");
    expect(typeof daytona.createDaytonaSandboxProvider).toBe("function");

    const vercel = await importBarrel("../src/vercel.js");
    expect(vercel.VERCEL_SANDBOX_PROVIDER_ID).toBe("vercel-sandbox");
    expect(typeof vercel.createVercelSandboxProvider).toBe("function");

    const gcp = await importBarrel("../src/gcp.js");
    expect(gcp.GCP_SANDBOX_PROVIDER_ID).toBe("gcp-sandbox");
    expect(typeof gcp.createGcpSandboxProvider).toBe("function");

    const sandbox = await importBarrel("../src/sandbox.js");
    // The sandbox core barrel exposes the shared provider-kit surface.
    expect(Object.keys(sandbox).length).toBeGreaterThan(0);
  });

  test("cloudflare barrel adds createSmithersCloudflare on top of the package surface", async () => {
    const cloudflare = await importBarrel("../src/cloudflare.js");
    expect(cloudflare.CLOUDFLARE_SANDBOX_PROVIDER_ID).toBe("cloudflare-sandbox");
    expect(typeof cloudflare.createSmithersCloudflare).toBe("function");
    expect(typeof cloudflare.createCloudflareDurableObjectSqliteDescriptor).toBe("function");
    expect(typeof cloudflare.createCloudflareD1SqliteDescriptor).toBe("function");
  });

  test("control-plane barrel re-exports the store and table bootstrap", async () => {
    const cp = await importBarrel("../src/control-plane.js");
    expect(typeof cp.ControlPlaneStore).toBe("function");
    expect(typeof cp.ensureControlPlaneTables).toBe("function");
  });

  test("gateway barrels re-export the client, react hooks, ui, and rpc surfaces", async () => {
    const client = await importBarrel("../src/gateway-client.js");
    expect(typeof client.SmithersGatewayClient).toBe("function");
    expect(typeof client.createSmithersCollections).toBe("function");
    expect(client.GATEWAY_EXTENSION_METHOD_PREFIX).toBeDefined();

    const react = await importBarrel("../src/gateway-react.js");
    expect(Object.keys(react).length).toBeGreaterThan(0);

    const ui = await importBarrel("../src/gateway-ui.js");
    expect(typeof ui.WorkflowUiShell).toBe("function");
    expect(typeof ui.isTerminalRunStatus).toBe("function");

    const gateway = await importBarrel("../src/gateway.js");
    expect(typeof gateway.Gateway).toBe("function");
    expect(typeof gateway.validateGatewayMethodName).toBe("function");
    expect(gateway.GATEWAY_RPC_MAX_PAYLOAD_BYTES).toBeGreaterThan(0);
  });

  test("server and serve barrels re-export the boot surfaces", async () => {
    const server = await importBarrel("../src/server.js");
    expect(Object.keys(server).length).toBeGreaterThan(0);

    const serve = await importBarrel("../src/serve.js");
    expect(typeof serve.createServeApp).toBe("function");
  });

  test("memory barrel re-exports the memory service and stores", async () => {
    const memory = await importBarrel("../src/memory.js");
    expect(typeof memory.MemoryService).toBe("function");
    expect(typeof memory.createMemoryStore).toBe("function");
    expect(typeof memory.parseNamespace).toBe("function");
  });

  test("telegram barrel re-exports the client and helpers", async () => {
    const telegram = await importBarrel("../src/telegram.js");
    expect(typeof telegram.createTelegramClient).toBe("function");
    expect(telegram.TELEGRAM_API_ROOT).toContain("telegram");
    expect(typeof telegram.splitTelegramText).toBe("function");
  });

  test("observability, openapi, scorers, and ui barrels resolve their surfaces", async () => {
    const observability = await importBarrel("../src/observability.js");
    expect(Object.keys(observability).length).toBeGreaterThan(0);

    const openapi = await importBarrel("../src/openapi.js");
    expect(Object.keys(openapi).length).toBeGreaterThan(0);

    const scorers = await importBarrel("../src/scorers.js");
    expect(Object.keys(scorers).length).toBeGreaterThan(0);

    const ui = await importBarrel("../src/ui.js");
    expect(Object.keys(ui).length).toBeGreaterThan(0);
  });

  test("testing barrel re-exports the deterministic harness", async () => {
    const testing = await importBarrel("../src/testing.js");
    expect(typeof testing.fakeAgent).toBe("function");
    expect(typeof testing.renderWorkflow).toBe("function");
    expect(typeof testing.runTask).toBe("function");
  });

  test("jsx-runtime barrel re-exports the reconciler runtime", async () => {
    const runtime = await importBarrel("../src/jsx-runtime.js");
    expect(typeof runtime.jsx).toBe("function");
    expect(typeof runtime.jsxs).toBe("function");
    expect(typeof runtime.jsxDEV).toBe("function");
    expect(runtime.Fragment).toBeDefined();
  });

  test("dom renderer barrel re-exports the SmithersRenderer", async () => {
    const dom = await importBarrel("../src/dom/renderer.js");
    expect(dom.SmithersRenderer).toBeDefined();
  });

  test("examples-entry barrel re-exports components, agents, and the engine runners", async () => {
    const examples = await importBarrel("../src/examples-entry.js");
    expect(typeof examples.Workflow).toBe("function");
    expect(typeof examples.Task).toBe("function");
    expect(typeof examples.createSmithers).toBe("function");
    expect(typeof examples.ClaudeCodeAgent).toBe("function");
    expect(typeof examples.KimiAgent).toBe("function");
    expect(typeof examples.PiAgent).toBe("function");
    expect(typeof examples.runWorkflow).toBe("function");
    expect(typeof examples.renderFrame).toBe("function");
    expect(examples.approvalDecisionSchema).toBeDefined();
  });
});
