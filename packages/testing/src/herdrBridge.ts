/**
 * Optional herdr bridge for core workflow scenarios (T3).
 * Soft-degrades when no herdr server is reachable.
 */

import { createHerdrClient, createHerdrRunSurface } from "@smthrs/herdr";

/** @typedef {import("@smthrs/herdr").HerdrClient} HerdrClient */
/** @typedef {import("@smthrs/herdr").HerdrRunSurface} HerdrRunSurface */

export type HerdrBridgeOptions = {
  session?: string;
  /** Workspace label find-or-create key (should include full runId). */
  workspaceLabel: string;
  /**
   * Workspace cwd for panes — must contain `smithers.db` when using live tails
   * (findSmithersDb walks from here).
   */
  cwd?: string;
  runId: string;
  softPinSlots?: number;
  tabCap?: number;
  /**
   * When true (default), panes run `sleep 3600` so unit tests don't need the
   * smithers CLI. Set false for human watch with real `smithers tail` content.
   */
  stubPanes?: boolean;
  /**
   * Absolute path to apps/cli/src/index.js (or bundled cli). Required when
   * stubPanes is false so panes invoke the same CLI as production herdr.
   */
  cliPath?: string;
  /**
   * When true (default), call surface.attach before the run. Prefer false for
   * live tails so the cockpit command starts only after the run row exists
   * (first onProgress event) — matching `smithers up --herdr`.
   */
  attachEagerly?: boolean;
  /**
   * After workspace appears, call workspace.focus so the herdr UI jumps to this run.
   * Default true for campaign visibility.
   */
  focusWorkspace?: boolean;
  /** Cockpit chrome: split harness|overview, tabs, or auto. */
  chrome?: "split" | "tabs" | "auto";
  /**
   * Left-pane harness (`"auto"` / argv / `"none"`). Live campaigns use `"auto"`.
   */
  harnessCommand?: string[] | "auto" | "none" | false | true | string;
  /** Dock into focused operator workspace (path A / ops). */
  dock?: boolean;
  /** Keep operator workspace label (default true when dock). */
  renameWorkspaceOnDock?: boolean;
  logger?: (level: "warn" | "debug", msg: string, data?: unknown) => void;
};

export type HerdrBridgeClient = {
  socketPath: string;
  ping: (options?: { requireProtocolMatch?: boolean }) => Promise<unknown>;
  tryCall: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

export type HerdrBridge = {
  surface: {
    onEvent: (event: any) => void;
    attach: (runId: string) => Promise<void>;
    close: () => Promise<void>;
  };
  client: HerdrBridgeClient;
  workspaceLabel: string;
  runId: string;
  /** Feed engine progress events into the mirror. */
  onProgress: (event: unknown) => void;
  close: () => Promise<void>;
};

const STUB_SLEEP = ["bash", "-c", "exec sleep 3600"];

/**
 * Probe herdr and create a run surface. Returns null if unreachable.
 */
export async function tryCreateHerdrBridge(opts: HerdrBridgeOptions): Promise<HerdrBridge | null> {
  const log =
    opts.logger ??
    ((level: string, msg: string) => {
      if (level === "warn") console.warn(`[herdr-bridge] ${msg}`);
    });
  const client = createHerdrClient({
    session: opts.session,
    logger: () => {},
  });
  const pong = await client.ping({ requireProtocolMatch: true }).catch(() => undefined);
  if (!pong) {
    log("warn", `no herdr server at ${client.socketPath}; running without mirror`);
    return null;
  }

  const stub = opts.stubPanes !== false;
  const attachEagerly = opts.attachEagerly !== false;
  /** @type {Record<string, unknown>} */
  const paneCommands: Record<string, unknown> = {};
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
    // Match apps/cli herdr.js buildOverviewCommand / buildTailCommand.
    // Long-lived portable board (`smithers supervisor`) — discovers runs in this DB
    // (fixes RUN_NOT_FOUND from per-run tail against the wrong cwd).
    // Prefer absolute path so the pane does not depend on herdr's cwd.
    const dbFile =
      typeof opts.cwd === "string" && opts.cwd !== "" ? `${opts.cwd.replace(/\/$/, "")}/smithers.db` : "smithers.db";
    paneCommands.overviewCommand = () => {
      const argv = [bin, cliPath, "top", "--db", dbFile];
      if (opts.cwd) argv.push("--cwd", opts.cwd);
      return argv;
    };
    paneCommands.tailCommand = (ctx: { runId: string; nodeId: string }) => [
      bin,
      cliPath,
      "tail",
      ctx.runId,
      "--node",
      ctx.nodeId,
      "--hud",
      "--linger",
    ];
    paneCommands.gateCommand = (ctx: { runId: string; nodeId: string }) => [
      bin,
      cliPath,
      "approve",
      ctx.runId,
      "--watch",
      "--node",
      ctx.nodeId,
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
    ...paneCommands,
  });

  const bridgeClient = client as HerdrBridgeClient;
  if (attachEagerly) {
    await surface.attach(opts.runId);
    if (opts.focusWorkspace !== false) {
      await focusHerdrWorkspaceByLabel(bridgeClient, {
        workspaceLabel: opts.workspaceLabel,
        runId: opts.runId,
      });
    }
  }

  let focusScheduled = attachEagerly && opts.focusWorkspace !== false;
  return {
    surface: {
      onEvent: (event: any) => surface.onEvent(event),
      attach: (id: string) => surface.attach(id),
      close: () => surface.close(),
    },
    client: bridgeClient,
    workspaceLabel: opts.workspaceLabel,
    runId: opts.runId,
    onProgress(event) {
      // Live path: do not pre-attach; first engine event creates the workspace
      // after the run row exists (same as smithers up --herdr).
      surface.onEvent(event as any);
      if (!focusScheduled && opts.focusWorkspace !== false) {
        focusScheduled = true;
        void (async () => {
          await new Promise((r) => setTimeout(r, 150));
          await focusHerdrWorkspaceByLabel(bridgeClient, {
            workspaceLabel: opts.workspaceLabel,
            runId: opts.runId,
          });
        })();
      }
    },
    async close() {
      await surface.close();
    },
  };
}

/**
 * Focus a workspace by label/runId (best-effort).
 */
export async function focusHerdrWorkspaceByLabel(
  client: HerdrBridgeClient,
  opts: { workspaceLabel: string; runId: string },
): Promise<boolean> {
  const snap = await snapshotHerdrWorkspace(client, opts);
  if (!snap) return false;
  await client.tryCall("workspace.focus", { workspace_id: snap.workspaceId });
  return true;
}

/** Campaign fixture workspaces: core-hello / core-sequence / … or camp- run ids. */
export function isCampaignWorkspaceLabel(label: string): boolean {
  const bare = label.replace(/^[✓✗◻]\s+/, "");
  return (
    /^core-(hello|sequence|parallel|hitl|steer|retry|loop|hang|stream|mixed|branch|continue|system)\b/.test(bare) ||
    /\bcamp-[a-z0-9]+-/i.test(bare) ||
    bare.startsWith("core-")
  );
}

/**
 * Close all prior campaign/fixture workspaces (leaves ~ and user runs like poem-*).
 * Returns number closed.
 */
export async function tryCloseCampaignHerdrWorkspaces(client: HerdrBridgeClient): Promise<number> {
  const list = (await client.tryCall("workspace.list", {})) as
    | { workspaces?: Array<{ workspace_id?: string; label?: string }> }
    | undefined;
  let n = 0;
  for (const w of list?.workspaces ?? []) {
    if (typeof w.label === "string" && isCampaignWorkspaceLabel(w.label) && typeof w.workspace_id === "string") {
      await client.tryCall("workspace.close", { workspace_id: w.workspace_id });
      n += 1;
    }
  }
  return n;
}

export type HerdrWorkspaceSnapshot = {
  workspaceId: string;
  label: string;
  tabs: Array<{ tab_id: string; label: string; pane_count?: number }>;
  agents: Array<{ name: string; agent_status?: string; pane_id?: string; workspace_id?: string }>;
};

/**
 * Snapshot herdr workspace matching label (outcome markers tolerated via substring runId).
 */
export async function snapshotHerdrWorkspace(
  client: HerdrBridgeClient,
  opts: { workspaceLabel: string; runId: string },
): Promise<HerdrWorkspaceSnapshot | null> {
  const list = (await client.tryCall("workspace.list", {})) as
    | { workspaces?: Array<{ workspace_id?: string; label?: string }> }
    | undefined;
  const workspaces = list?.workspaces ?? [];
  const ws = workspaces.find(
    (w) =>
      typeof w.label === "string" &&
      (w.label === opts.workspaceLabel || w.label.endsWith(` ${opts.runId}`) || w.label.includes(opts.runId)),
  );
  if (!ws || typeof ws.workspace_id !== "string") {
    return null;
  }
  const tabsRes = (await client.tryCall("tab.list", { workspace_id: ws.workspace_id })) as
    | { tabs?: Array<{ tab_id: string; label: string; pane_count?: number }> }
    | undefined;
  const agentsRes = (await client.tryCall("agent.list", {})) as
    | { agents?: Array<{ name: string; agent_status?: string; pane_id?: string; workspace_id?: string }> }
    | undefined;
  const agents = (agentsRes?.agents ?? []).filter((a) => a.workspace_id === ws.workspace_id);
  return {
    workspaceId: ws.workspace_id,
    label: String(ws.label ?? ""),
    tabs: tabsRes?.tabs ?? [],
    agents,
  };
}

export type HerdrAssertOptions = {
  /** Expect a cockpit (or legacy overview) tab. Default true. */
  expectCockpit?: boolean;
  /** Tab labels that must appear (substring or exact). */
  mustIncludeTabLabels?: string[];
  /** Tab labels that must not appear. */
  mustExcludeTabLabels?: string[];
  /** Max non-cockpit/overview tabs (soft-pin pressure). */
  maxDetailTabs?: number;
  /** Require at least one agent with this status. */
  requireAgentStatus?: "blocked" | "working" | "idle";
};

/**
 * Machine oracle over herdr state after a scenario. Throws on violation.
 */
export async function assertHerdrBridge(
  client: HerdrBridgeClient,
  opts: { workspaceLabel: string; runId: string } & HerdrAssertOptions,
): Promise<HerdrWorkspaceSnapshot> {
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
      throw new Error(`expected ≤${opts.maxDetailTabs} detail tabs, got ${detail.length}: [${detail.join(", ")}]`);
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

/**
 * Best-effort close workspaces for a run (campaign cleanup). Soft.
 */
export async function tryCloseHerdrWorkspacesForRun(client: HerdrBridgeClient, runId: string): Promise<number> {
  const list = (await client.tryCall("workspace.list", {})) as
    | { workspaces?: Array<{ workspace_id?: string; label?: string }> }
    | undefined;
  let n = 0;
  for (const w of list?.workspaces ?? []) {
    if (typeof w.label === "string" && w.label.includes(runId) && typeof w.workspace_id === "string") {
      await client.tryCall("workspace.close", { workspace_id: w.workspace_id });
      n += 1;
    }
  }
  return n;
}

/**
 * Probe herdr and return a client, or null if unreachable.
 */
export async function tryOpenHerdrClient(opts?: { session?: string }): Promise<HerdrBridgeClient | null> {
  const client = createHerdrClient({
    session: opts?.session,
    logger: () => {},
  });
  const pong = await client.ping({ requireProtocolMatch: true }).catch(() => undefined);
  if (!pong) return null;
  return client as HerdrBridgeClient;
}
