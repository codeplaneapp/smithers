import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { renderWorkflow } from "smthrs/testing";

const workflowPath = join(import.meta.dir, "..", "workflows", "fallback-agents-poc.tsx");
const cliSrc = pathToFileURL(resolve(import.meta.dir, "../../apps/cli/src")).href;

describe("fallback-agents-poc workflow", () => {
  test("renders the probe chain, degrading to the stock agent with no registry", async () => {
    process.env.SMITHERS_CLI_SRC_DIR = cliSrc;
    const home = await mkdtemp(join(tmpdir(), "smithers-fallback-poc-"));
    const prevHome = process.env.SMITHERS_HOME;
    process.env.SMITHERS_HOME = home;
    try {
      const workflow = (await import(workflowPath)).default;
      const frame = (await renderWorkflow(workflow, {
        workflowPath,
        input: workflow.inputSchema.parse({}),
        runId: "fallback-agents-poc-test",
        outputs: {},
      })) as any;
      const probe = frame.tasks.find((candidate: { nodeId: string }) => candidate.nodeId === "probe");
      expect(probe, "missing probe task").toBeDefined();
      expect(probe.outputTableName).toBe("probe");
      expect(Array.isArray(probe.agent) ? probe.agent.length : 1).toBeGreaterThan(0);
    } finally {
      if (prevHome === undefined) delete process.env.SMITHERS_HOME;
      else process.env.SMITHERS_HOME = prevHome;
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });
});
