import { describe, expect, test } from "bun:test";
import { createHerdrRunSurface, openTabPane } from "../src/createHerdrRunSurface.js";

describe("openTabPane ownership safety (fake client)", () => {
  test("a colliding operator tab label is never reused or closed", async () => {
    /** @type {Array<{ method: string, params: Record<string, any> }>} */
    const calls = [];
    const route = async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "agent.list") return { agents: [] };
      if (method === "tab.list") {
        return { tabs: [{ tab_id: "operator-tab", workspace_id: "ws", label: "build" }] };
      }
      if (method === "tab.create") {
        return {
          tab: { tab_id: "smithers-tab", workspace_id: "ws", label: params.label },
          root_pane: { pane_id: "smithers-pane", tab_id: "smithers-tab", workspace_id: "ws" },
        };
      }
      if (method === "pane.list") {
        return {
          panes: [
            { pane_id: "operator-pane", tab_id: "operator-tab", workspace_id: "ws" },
            { pane_id: "smithers-seed", tab_id: "smithers-tab", workspace_id: "ws" },
            { pane_id: "smithers-pane", tab_id: "smithers-tab", workspace_id: "ws" },
          ],
        };
      }
      return { type: "ok" };
    };
    const client = {
      socketPath: "/fake/herdr.sock",
      call: route,
      tryCall: route,
      subscribe: () => ({ close() {} }),
      ping: async () => undefined,
    };

    const opened = await openTabPane(client, {
      workspaceId: "ws",
      label: "build",
      name: "smithers:run-1:build",
      argv: ["sleep", "30"],
    });

    expect(opened).toMatchObject({ tabId: "smithers-tab", paneId: "smithers-pane", workspaceId: "ws" });
    expect(calls.find((call) => call.method === "pane.report_agent")?.params).toMatchObject({
      pane_id: "smithers-pane",
      agent: "smithers:run-1:build",
    });
    expect(calls.find((call) => call.method === "pane.send_input")?.params).toMatchObject({
      pane_id: "smithers-pane",
      text: "sleep 30",
      keys: ["Enter"],
    });
    expect(calls.filter((call) => call.method === "tab.close")).toEqual([]);
    expect(calls.filter((call) => call.method === "pane.close").map((call) => call.params.pane_id)).toEqual([
      "smithers-seed",
    ]);
  });
});

describe("createHerdrRunSurface workspace barrier (fake client)", () => {
  test("does not adopt an operator workspace whose label only shares the run marker", async () => {
    const runId = "run-collision-0000000000";
    const targetLabel = `workflow [smithers:v1:${runId}]`;
    const operatorWorkspace = {
      workspace_id: "operator-workspace",
      number: 1,
      label: `operator notes [smithers:v1:${runId}]`,
    };
    /** @type {any[]} */
    const workspaces = [operatorWorkspace];
    let createCalls = 0;
    const route = async (method, params = {}) => {
      if (method === "workspace.list") return { workspaces: [...workspaces] };
      if (method === "workspace.create") {
        createCalls += 1;
        const workspace = { workspace_id: "smithers-workspace", number: 2, label: params.label };
        workspaces.push(workspace);
        return {
          workspace,
          tab: { tab_id: "smithers-tab", workspace_id: workspace.workspace_id },
          root_pane: { pane_id: "smithers-root" },
        };
      }
      if (method === "agent.list") return { agents: [] };
      return { type: "ok" };
    };
    const client = {
      socketPath: "/fake/ownership-herdr.sock",
      call: route,
      tryCall: route,
      subscribe: () => ({ close() {} }),
      ping: async () => undefined,
    };
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: targetLabel,
      overviewCommand: () => [],
      logger: () => {},
    });

    await surface.attach(runId);
    expect(createCalls).toBe(1);
    expect(await surface.workspaceId()).toBe("smithers-workspace");
    expect(workspaces).toContainEqual(operatorWorkspace);
    await surface.close();
  });

  test("a protocol mismatch disables the surface before any mutation", async () => {
    /** @type {Array<{ method: string, params: Record<string, any> }>} */
    const calls = [];
    const route = async (method, params = {}) => {
      calls.push({ method, params });
      return { type: "ok" };
    };
    const client = {
      socketPath: "/fake/mismatched-herdr.sock",
      call: route,
      tryCall: route,
      subscribe: () => ({ close() {} }),
      // Deliberately ignore the strict option: the surface must inspect pong.
      ping: async () => ({ type: "pong", version: "future", protocol: 999 }),
    };
    const warnings = [];
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: "workflow run-mismatch-0000000000",
      overviewCommand: () => [],
      logger: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    await surface.attach("run-mismatch-0000000000");
    expect(await surface.workspaceId()).toBeUndefined();
    expect(calls).toEqual([]);
    expect(warnings.some((message) => message.includes("protocol mismatch") && message.includes("disabled"))).toBe(
      true,
    );
    await surface.close();
  });

  test("concurrent surfaces for one run share one workspace creation", async () => {
    const runId = "run-concurrent-0000000000";
    /** @type {any[]} */
    const workspaces = [];
    let listCalls = 0;
    let createCalls = 0;
    /** @type {Array<() => void>} */
    const releaseInitialLists = [];
    const route = async (method, params = {}) => {
      if (method === "workspace.list") {
        listCalls += 1;
        if (listCalls <= 2) {
          await new Promise((resolve) => {
            releaseInitialLists.push(resolve);
            if (releaseInitialLists.length === 2) {
              for (const release of releaseInitialLists) release();
            }
          });
        }
        return { workspaces: [...workspaces] };
      }
      if (method === "workspace.create") {
        createCalls += 1;
        const workspace = {
          workspace_id: `workspace-${createCalls}`,
          number: createCalls,
          label: params.label,
        };
        workspaces.push(workspace);
        return {
          workspace,
          tab: { tab_id: `tab-${createCalls}`, workspace_id: workspace.workspace_id },
          root_pane: { pane_id: `root-${createCalls}` },
        };
      }
      if (method === "agent.list") return { agents: [] };
      return { type: "ok" };
    };
    const client = {
      socketPath: "/fake/concurrent-herdr.sock",
      call: route,
      tryCall: route,
      subscribe: () => ({ close() {} }),
      ping: async () => undefined,
    };
    const options = {
      client,
      workspaceLabel: `workflow ${runId}`,
      overviewCommand: () => [],
      logger: () => {},
    };
    const first = createHerdrRunSurface(options);
    const second = createHerdrRunSurface(options);

    await Promise.all([first.attach(runId), second.attach(runId)]);
    expect(createCalls).toBe(1);
    expect(workspaces).toHaveLength(1);
    expect(await Promise.all([first.workspaceId(), second.workspaceId()])).toEqual(["workspace-1", "workspace-1"]);

    await Promise.all([first.close(), second.close()]);
  });
});
