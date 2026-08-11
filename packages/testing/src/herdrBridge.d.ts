/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Optional herdr bridge for core workflow scenarios (T3).
 * Soft-degrades when no herdr server is reachable.
 */
/** @typedef {import("@smthrs/herdr").HerdrClient} HerdrClient */
/** @typedef {import("@smthrs/herdr").HerdrRunSurface} HerdrRunSurface */
type HerdrBridgeOptions = {
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
type HerdrBridgeClient = {
    socketPath: string;
    ping: (options?: {
        requireProtocolMatch?: boolean;
    }) => Promise<unknown>;
    tryCall: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};
type HerdrBridge = {
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
/**
 * Probe herdr and create a run surface. Returns null if unreachable.
 */
declare function tryCreateHerdrBridge(opts: HerdrBridgeOptions): Promise<HerdrBridge | null>;
/**
 * Focus a workspace by label/runId (best-effort).
 */
declare function focusHerdrWorkspaceByLabel(client: HerdrBridgeClient, opts: {
    workspaceLabel: string;
    runId: string;
}): Promise<boolean>;
/** Campaign fixture workspaces: core-hello / core-sequence / … or camp- run ids. */
declare function isCampaignWorkspaceLabel(label: string): boolean;
/**
 * Close all prior campaign/fixture workspaces (leaves ~ and user runs like poem-*).
 * Returns number closed.
 */
declare function tryCloseCampaignHerdrWorkspaces(client: HerdrBridgeClient): Promise<number>;
type HerdrWorkspaceSnapshot = {
    workspaceId: string;
    label: string;
    tabs: Array<{
        tab_id: string;
        label: string;
        pane_count?: number;
    }>;
    agents: Array<{
        name: string;
        agent_status?: string;
        pane_id?: string;
        workspace_id?: string;
    }>;
};
/**
 * Snapshot herdr workspace matching label (outcome markers tolerated via substring runId).
 */
declare function snapshotHerdrWorkspace(client: HerdrBridgeClient, opts: {
    workspaceLabel: string;
    runId: string;
}): Promise<HerdrWorkspaceSnapshot | null>;
type HerdrAssertOptions = {
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
declare function assertHerdrBridge(client: HerdrBridgeClient, opts: {
    workspaceLabel: string;
    runId: string;
} & HerdrAssertOptions): Promise<HerdrWorkspaceSnapshot>;
/**
 * Best-effort close workspaces for a run (campaign cleanup). Soft.
 */
declare function tryCloseHerdrWorkspacesForRun(client: HerdrBridgeClient, runId: string): Promise<number>;
/**
 * Probe herdr and return a client, or null if unreachable.
 */
declare function tryOpenHerdrClient(opts?: {
    session?: string;
}): Promise<HerdrBridgeClient | null>;

export { type HerdrAssertOptions, type HerdrBridge, type HerdrBridgeClient, type HerdrBridgeOptions, type HerdrWorkspaceSnapshot, assertHerdrBridge, focusHerdrWorkspaceByLabel, isCampaignWorkspaceLabel, snapshotHerdrWorkspace, tryCloseCampaignHerdrWorkspaces, tryCloseHerdrWorkspacesForRun, tryCreateHerdrBridge, tryOpenHerdrClient };
