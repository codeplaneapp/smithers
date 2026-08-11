// src/herdrBridge.ts
import { createHerdrClient, createHerdrRunSurface } from "@smthrs/herdr";
var STUB_SLEEP = ["bash", "-c", "exec sleep 3600"];
async function tryCreateHerdrBridge(opts) {
  const log = opts.logger ?? ((level, msg) => {
    if (level === "warn") console.warn(`[herdr-bridge] ${msg}`);
  });
  const client = createHerdrClient({
    session: opts.session,
    logger: () => {
    }
  });
  const pong = await client.ping({ requireProtocolMatch: true }).catch(() => void 0);
  if (!pong) {
    log("warn", `no herdr server at ${client.socketPath}; running without mirror`);
    return null;
  }
  const stub = opts.stubPanes !== false;
  const attachEagerly = opts.attachEagerly !== false;
  const paneCommands = {};
  if (stub) {
    paneCommands.overviewCommand = () => STUB_SLEEP;
    paneCommands.tailCommand = () => STUB_SLEEP;
    paneCommands.gateCommand = () => STUB_SLEEP;
  } else {
    const cliPath = opts.cliPath;
    if (typeof cliPath !== "string" || cliPath === "") {
      throw new Error("tryCreateHerdrBridge: cliPath is required when stubPanes=false (path to apps/cli/src/index.js)");
    }
    const bin = process.execPath;
    const dbFile = typeof opts.cwd === "string" && opts.cwd !== "" ? `${opts.cwd.replace(/\/$/, "")}/smithers.db` : "smithers.db";
    paneCommands.overviewCommand = () => {
      const argv = [bin, cliPath, "top", "--db", dbFile];
      if (opts.cwd) argv.push("--cwd", opts.cwd);
      return argv;
    };
    paneCommands.tailCommand = (ctx) => [
      bin,
      cliPath,
      "tail",
      ctx.runId,
      "--node",
      ctx.nodeId,
      "--hud",
      "--linger"
    ];
    paneCommands.gateCommand = (ctx) => [
      bin,
      cliPath,
      "approve",
      ctx.runId,
      "--watch",
      "--node",
      ctx.nodeId
    ];
    log("debug", `live panes via ${bin} ${cliPath} (cwd must contain smithers.db)`);
  }
  const surface = createHerdrRunSurface({
    client,
    workspaceLabel: opts.workspaceLabel,
    cwd: opts.cwd,
    softPinSlots: opts.softPinSlots ?? 1,
    tabCap: opts.tabCap ?? 6,
    autoOpen: { stage: true, workers: false, gates: true, failures: true },
    closeWorkspaceOnFinish: false,
    // Live UI: harness|overview split. Stubs/machine: tabs/full-width overview.
    chrome: opts.chrome ?? (stub ? "tabs" : "split"),
    harnessCommand: opts.harnessCommand ?? (stub ? "none" : "auto"),
    dock: opts.dock === true,
    renameWorkspaceOnDock: opts.renameWorkspaceOnDock === true,
    logger: (level, msg, data) => log(level, msg, data),
    ...paneCommands
  });
  const bridgeClient = client;
  if (attachEagerly) {
    await surface.attach(opts.runId);
    if (opts.focusWorkspace !== false) {
      await focusHerdrWorkspaceByLabel(bridgeClient, {
        workspaceLabel: opts.workspaceLabel,
        runId: opts.runId
      });
    }
  }
  let focusScheduled = attachEagerly && opts.focusWorkspace !== false;
  return {
    surface: {
      onEvent: (event) => surface.onEvent(event),
      attach: (id) => surface.attach(id),
      close: () => surface.close()
    },
    client: bridgeClient,
    workspaceLabel: opts.workspaceLabel,
    runId: opts.runId,
    onProgress(event) {
      surface.onEvent(event);
      if (!focusScheduled && opts.focusWorkspace !== false) {
        focusScheduled = true;
        void (async () => {
          await new Promise((r) => setTimeout(r, 150));
          await focusHerdrWorkspaceByLabel(bridgeClient, {
            workspaceLabel: opts.workspaceLabel,
            runId: opts.runId
          });
        })();
      }
    },
    async close() {
      await surface.close();
    }
  };
}
async function focusHerdrWorkspaceByLabel(client, opts) {
  const snap = await snapshotHerdrWorkspace(client, opts);
  if (!snap) return false;
  await client.tryCall("workspace.focus", { workspace_id: snap.workspaceId });
  return true;
}
function isCampaignWorkspaceLabel(label) {
  const bare = label.replace(/^[✓✗◻]\s+/, "");
  return /^core-(hello|sequence|parallel|hitl|steer|retry|loop|hang|stream|mixed|branch|continue|system)\b/.test(bare) || /\bcamp-[a-z0-9]+-/i.test(bare) || bare.startsWith("core-");
}
async function tryCloseCampaignHerdrWorkspaces(client) {
  const list = await client.tryCall("workspace.list", {});
  let n = 0;
  for (const w of list?.workspaces ?? []) {
    if (typeof w.label === "string" && isCampaignWorkspaceLabel(w.label) && typeof w.workspace_id === "string") {
      await client.tryCall("workspace.close", { workspace_id: w.workspace_id });
      n += 1;
    }
  }
  return n;
}
async function snapshotHerdrWorkspace(client, opts) {
  const list = await client.tryCall("workspace.list", {});
  const workspaces = list?.workspaces ?? [];
  const ws = workspaces.find(
    (w) => typeof w.label === "string" && (w.label === opts.workspaceLabel || w.label.endsWith(` ${opts.runId}`) || w.label.includes(opts.runId))
  );
  if (!ws || typeof ws.workspace_id !== "string") {
    return null;
  }
  const tabsRes = await client.tryCall("tab.list", { workspace_id: ws.workspace_id });
  const agentsRes = await client.tryCall("agent.list", {});
  const agents = (agentsRes?.agents ?? []).filter((a) => a.workspace_id === ws.workspace_id);
  return {
    workspaceId: ws.workspace_id,
    label: String(ws.label ?? ""),
    tabs: tabsRes?.tabs ?? [],
    agents
  };
}
async function assertHerdrBridge(client, opts) {
  const snap = await snapshotHerdrWorkspace(client, opts);
  if (!snap) {
    throw new Error(`herdr workspace not found for run ${opts.runId} (label ${opts.workspaceLabel})`);
  }
  const labels = snap.tabs.map((t) => t.label);
  if (opts.expectCockpit !== false) {
    const hasCockpit = labels.some((l) => l === "cockpit" || l === "overview");
    if (!hasCockpit) {
      throw new Error(`expected cockpit/overview tab, got [${labels.join(", ")}]`);
    }
  }
  for (const want of opts.mustIncludeTabLabels ?? []) {
    if (!labels.some((l) => l === want || l.includes(want))) {
      throw new Error(`expected tab containing "${want}", got [${labels.join(", ")}]`);
    }
  }
  for (const ban of opts.mustExcludeTabLabels ?? []) {
    if (labels.some((l) => l === ban || l.includes(ban))) {
      throw new Error(`unexpected tab "${ban}" in [${labels.join(", ")}]`);
    }
  }
  if (typeof opts.maxDetailTabs === "number") {
    const detail = labels.filter((l) => l !== "cockpit" && l !== "overview");
    if (detail.length > opts.maxDetailTabs) {
      throw new Error(`expected \u2264${opts.maxDetailTabs} detail tabs, got ${detail.length}: [${detail.join(", ")}]`);
    }
  }
  if (opts.requireAgentStatus) {
    const hit = snap.agents.some((a) => a.agent_status === opts.requireAgentStatus);
    if (!hit) {
      const statuses = snap.agents.map((a) => `${a.name}:${a.agent_status}`).join(", ");
      throw new Error(`expected an agent with status ${opts.requireAgentStatus}, got [${statuses}]`);
    }
  }
  return snap;
}
async function tryCloseHerdrWorkspacesForRun(client, runId) {
  const list = await client.tryCall("workspace.list", {});
  let n = 0;
  for (const w of list?.workspaces ?? []) {
    if (typeof w.label === "string" && w.label.includes(runId) && typeof w.workspace_id === "string") {
      await client.tryCall("workspace.close", { workspace_id: w.workspace_id });
      n += 1;
    }
  }
  return n;
}
async function tryOpenHerdrClient(opts) {
  const client = createHerdrClient({
    session: opts?.session,
    logger: () => {
    }
  });
  const pong = await client.ping({ requireProtocolMatch: true }).catch(() => void 0);
  if (!pong) return null;
  return client;
}
export {
  assertHerdrBridge,
  focusHerdrWorkspaceByLabel,
  isCampaignWorkspaceLabel,
  snapshotHerdrWorkspace,
  tryCloseCampaignHerdrWorkspaces,
  tryCloseHerdrWorkspacesForRun,
  tryCreateHerdrBridge,
  tryOpenHerdrClient
};
