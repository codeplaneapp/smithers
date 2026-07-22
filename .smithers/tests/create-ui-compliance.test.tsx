import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { simulate } from "smithers-orchestrator/testing";
import { gradeUi, verifyGatewayUi } from "../workflows/create-ui.tsx";

const target = "create-ui-gate-fixture";
const uiPath = `.smithers/ui/${target}.tsx`;
let server: ReturnType<typeof Bun.serve> | undefined;

const compliantSource = `/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
function App() { return <WorkflowUiShell title="Fixture" />; }
createGatewayReactRoot(<App />);
`;

afterEach(() => {
  server?.stop();
  server = undefined;
  rmSync(uiPath, { force: true });
});

function startGateway(statuses: { workflow: number; bundle: number }) {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const status = path.endsWith("client.js") ? statuses.bundle : statuses.workflow;
      return new Response(status === 200 ? "ok" : "gateway fixture failure", { status });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function authorResult(verified = true) {
  return { targetWorkflow: target, uiPath, verified, summary: "The fixture was authored and checked against Gateway." };
}

describe("create-ui compliance hard gate", () => {
  test("requires the author's verified claim even when both live routes work", async () => {
    mkdirSync(".smithers/ui", { recursive: true });
    writeFileSync(uiPath, compliantSource);
    const report = await gradeUi(target, startGateway({ workflow: 200, bundle: 200 }), authorResult(false));
    expect(report.passed).toBe(false);
    expect(report.violations).toContain("author-verified");
  });

  test("rejects an unavailable workflow page and client bundle", async () => {
    mkdirSync(".smithers/ui", { recursive: true });
    writeFileSync(uiPath, compliantSource);
    const report = await gradeUi(target, startGateway({ workflow: 503, bundle: 500 }), authorResult());
    expect(report.passed).toBe(false);
    expect(report.violations).toContain("gateway-workflow");
    expect(report.violations).toContain("gateway-bundle");
  });

  test("passes only after independently requesting both successful routes", async () => {
    const gatewayUrl = startGateway({ workflow: 200, bundle: 200 });
    await expect(verifyGatewayUi(target, gatewayUrl)).resolves.toEqual([]);
    mkdirSync(".smithers/ui", { recursive: true });
    writeFileSync(uiPath, compliantSource);
    await expect(gradeUi(target, gatewayUrl, authorResult())).resolves.toMatchObject({ passed: true });
  });

  test("keeps the three-round loop bounded and terminal", async () => {
    const workflow = (await import(`../workflows/create-ui.tsx?execution=${Date.now()}`)).default;
    const gatewayUrl = startGateway({ workflow: 200, bundle: 200 });
    const invalidSource = `${compliantSource}\nconst invalid = "#ff0000";\n`;
    const sim = simulate(workflow, {
      input: { targetWorkflow: target, gatewayUrl },
      mocks: {
        "author-and-verify": () => {
          mkdirSync(".smithers/ui", { recursive: true });
          writeFileSync(uiPath, invalidSource);
          return authorResult();
        },
      },
      workflowPath: pathToFileURL(`${import.meta.dir}/../workflows/create-ui.tsx`).href,
    });

    await expect(sim.run()).rejects.toMatchObject({ code: "RALPH_MAX_REACHED" });
    expect(sim.status).toBe("failed");
    expect(sim.task("author-and-verify").outputs).toHaveLength(3);
    expect(sim.executed).toEqual([
      "author-and-verify", "ui-compliance",
      "author-and-verify", "ui-compliance",
      "author-and-verify", "ui-compliance",
    ]);
  });
});
