import { afterEach, describe, expect, test } from "bun:test";
// Elements are built with the smithers jsx runtime directly so this file can
// stay .ts (no .tsx needed) while running the REAL engine + REAL gateway.
import { jsx, jsxs } from "smthrs/jsx-runtime";
import { Subflow } from "smthrs";
import { z } from "zod";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Gateway } from "../src/gateway.js";

const END_TO_END_TIMEOUT_MS = 60_000;

type AnyRow = Record<string, any>;

/** @type {(() => void)[]} */
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {}
  }
});

function buildParentWithSubflow() {
  const harness = createTestSmithers({
    leaf: z.object({ ok: z.boolean() }),
    subResult: z.object({ ok: z.boolean() }),
    done: z.object({ ok: z.boolean() }),
  }) as AnyRow;
  cleanups.push(harness.cleanup);
  const { smithers, Workflow, Task, outputs } = harness;
  const childWorkflow = smithers(
    () =>
      jsx(Workflow, {
        name: "xcombo-child",
        children: jsx(Task, { id: "leaf", output: outputs.leaf, children: { ok: true } }),
      }),
    { output: outputs.leaf },
  );
  const parentWorkflow = smithers(() =>
    jsxs(Workflow, {
      name: "xcombo-parent",
      children: [
        jsx(Subflow, {
          id: "sub",
          mode: "childRun",
          output: outputs.subResult,
          workflow: childWorkflow,
          input: {},
        }),
        jsx(Task, {
          id: "done",
          output: outputs.done,
          deps: { sub: outputs.subResult },
          children: (deps: AnyRow) => ({ ok: Boolean(deps.sub.ok) }),
        }),
      ],
    }),
  );
  return { parentWorkflow, harness };
}

describe("xcombo child-run visibility over the gateway", () => {
  test(
    "a <Subflow> child run of a gateway-launched parent is visible in the run list",
    async () => {
      const { parentWorkflow } = buildParentWithSubflow();
      const gateway = new Gateway() as AnyRow;
      cleanups.push(() => {
        try {
          gateway.close?.();
        } catch {}
      });
      gateway.register("main", parentWorkflow);
      const auth = { triggeredBy: "test", scopes: ["*"], role: "operator" };
      const launch = await gateway.startRun("main", {}, auth, "xcombo-parent-run", { resume: false });
      expect(launch.system).toBe(false);
      await gateway.inflightRuns.get("xcombo-parent-run");

      const adapter = gateway.adapterForWorkflow(parentWorkflow);
      const parentRow = await adapter.getRun("xcombo-parent-run");
      expect(parentRow?.status).toBe("finished");

      // The child run exists and the db linkage is correct.
      const childRow = await adapter.getLatestChildRun("xcombo-parent-run");
      expect(childRow?.runId).toBeString();
      expect(childRow?.parentRunId).toBe("xcombo-parent-run");
      expect(childRow?.status).toBe("finished");
      const childRunId = String(childRow?.runId);

      // With the debug escape hatch the child is there, so the row itself is
      // fine: the ordinary listing path is what loses it.
      const debugRows = await gateway.listRunsAcrossWorkflows(50, undefined, undefined, 0, true);
      expect(debugRows.map((row: AnyRow) => row.runId)).toContain(childRunId);
      expect(debugRows.find((row: AnyRow) => row.runId === childRunId)?.parentRunId).toBe("xcombo-parent-run");

      // The ordinary list is what every UI (Monitor run list, FleetTable,
      // listRuns RPC) renders. A child run of a visible parent must appear.
      const ordinaryRows = await gateway.listRunsAcrossWorkflows(50);
      expect(ordinaryRows.map((row: AnyRow) => row.runId)).toContain("xcombo-parent-run");
      expect(ordinaryRows.map((row: AnyRow) => row.runId)).toContain(childRunId);
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the engine stamps child runs with the parent's gateway visibility",
    async () => {
      const { parentWorkflow } = buildParentWithSubflow();
      const gateway = new Gateway() as AnyRow;
      cleanups.push(() => {
        try {
          gateway.close?.();
        } catch {}
      });
      gateway.register("main", parentWorkflow);
      const auth = { triggeredBy: "test", scopes: ["*"], role: "operator" };
      await gateway.startRun("main", {}, auth, "xcombo-stamp-run", { resume: false });
      await gateway.inflightRuns.get("xcombo-stamp-run");

      const adapter = gateway.adapterForWorkflow(parentWorkflow);
      const childRow = await adapter.getLatestChildRun("xcombo-stamp-run");
      const childConfig = JSON.parse(String(childRow?.configJson ?? "{}"));
      const parentConfig = JSON.parse(String((await adapter.getRun("xcombo-stamp-run"))?.configJson ?? "{}"));
      expect(parentConfig.gatewaySystem).toBe(false);
      // Fail-closed visibility means an unstamped row is treated as internal.
      // A child launched by a public parent inherits the parent's stamp, or it
      // silently disappears from every ordinary listing.
      expect(childConfig.gatewaySystem).toBe(false);
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a child run stays attributed to a workflow the gateway can serve",
    async () => {
      const { parentWorkflow } = buildParentWithSubflow();
      const gateway = new Gateway() as AnyRow;
      cleanups.push(() => {
        try {
          gateway.close?.();
        } catch {}
      });
      gateway.register("main", parentWorkflow);
      const auth = { triggeredBy: "test", scopes: ["*"], role: "operator" };
      await gateway.startRun("main", {}, auth, "xcombo-deeplink-run", { resume: false });
      await gateway.inflightRuns.get("xcombo-deeplink-run");

      const adapter = gateway.adapterForWorkflow(parentWorkflow);
      const childRunId = String((await adapter.getLatestChildRun("xcombo-deeplink-run"))?.runId);
      // Deep-linking to the child by id works, and the db knows the linkage.
      const resolved = await gateway.resolveRun(childRunId);
      expect(resolved).toBeTruthy();
      const childRow = await resolved.adapter.getRun(childRunId);
      expect(childRow?.runId).toBe(childRunId);
      expect(childRow?.parentRunId).toBe("xcombo-deeplink-run");
      const descendants = await adapter.listRunDescendants("xcombo-deeplink-run");
      expect(descendants.map((row: AnyRow) => [row.runId, row.depth])).toEqual([
        ["xcombo-deeplink-run", 0],
        [childRunId, 1],
      ]);

      // The child is attributed to its OWN <Workflow name>, which is not a
      // registered gateway workflow key. Every workflow-scoped surface (the
      // monitor's per-workflow run list, `listRuns` with filter.workflow,
      // `smithers ui --workflow`) therefore cannot reach the child even with
      // the debug escape hatch on, and the row it does return points at a
      // workflow the gateway cannot serve.
      expect([...gateway.workflows.keys()]).toContain(resolved.workflowKey);
      const scoped = await gateway.listRunsAcrossWorkflows(50, undefined, "main", 0, true);
      expect(scoped.map((row: AnyRow) => row.runId)).toContain(childRunId);
    },
    END_TO_END_TIMEOUT_MS,
  );
});
