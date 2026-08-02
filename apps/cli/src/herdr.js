import {
  createHerdrClient,
  createHerdrRunSurface,
  HERDR_PROTOCOL,
  HERDR_SURFACE_EVENT_TYPES,
  launchHijackPane,
  openTabPane,
  sessionAttachHint,
  shortNodeId,
  stripOutcomeMarker,
  stubWorkspaceLabel,
} from "@smithers-orchestrator/herdr";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveTailStatus, isTailActiveState } from "./tail.js";

/**
 * CLI wiring for the optional herdr mirror plane (`smithers up --herdr`,
 * `smithers herdr attach`, `smithers herdr status`). Everything here is
 * fire-and-forget and degradable: an absent or broken herdr never fails, blocks,
 * or slows a run. The run surface itself lives in `@smithers-orchestrator/herdr`;
 * this module supplies the CLI-specific bits (option parsing, the deterministic
 * workspace label, the real `smithers tail` pane command, the agent-node filter,
 * and the DB-poll follow loop that feeds an attached surface).
 */

/** DB poll cadence for the attach follow loop (mirrors the tail/logs interval). */
const HERDR_FOLLOW_POLL_INTERVAL_MS = 500;

/** Page size for draining new events into an attached surface. */
const HERDR_EVENT_PAGE_SIZE = 500;

/** @param {string} value */
function quotePosixShellArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Close the herdr detail tab/pane this process is running in (soft).
 * herdr injects HERDR_TAB_ID / HERDR_PANE_ID into agent panes; without an
 * explicit close, `q` exits the process and leaves a grey dead tab behind.
 *
 * Prefer tab.close (one full-size pane per detail tab). Never throws.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {import("@smithers-orchestrator/herdr").HerdrClient} [injectedClient]
 * @returns {Promise<void>}
 */
export async function closeCurrentHerdrDetail(env = process.env, injectedClient) {
  if (env.HERDR_ENV !== "1") return;
  const tabId = typeof env.HERDR_TAB_ID === "string" && env.HERDR_TAB_ID !== "" ? env.HERDR_TAB_ID : undefined;
  const paneId = typeof env.HERDR_PANE_ID === "string" && env.HERDR_PANE_ID !== "" ? env.HERDR_PANE_ID : undefined;
  if (!tabId && !paneId) return;
  try {
    const client = injectedClient ?? createHerdrClient({ logger: () => {} });
    const compatibility = await probeCompatibleHerdr(client);
    if (!compatibility.available) return;
    if (tabId) {
      await client.tryCall("tab.close", { tab_id: tabId });
      return;
    }
    if (paneId) {
      await client.tryCall("pane.close", { pane_id: paneId });
    }
  } catch {
    /* soft — never block detail exit */
  }
}

/**
 * Strict compatibility probe shared by every CLI path that may issue a Herdr
 * mutation. A protocol mismatch is intentionally distinct from an unreachable
 * socket so explicit commands can return a structured mismatch while optional
 * features retain their soft degradation contract.
 *
 * @param {import("@smithers-orchestrator/herdr").HerdrClient} client
 * @returns {Promise<
 *   | { available: true; pong: import("@smithers-orchestrator/herdr").HerdrPong }
 *   | { available: false; reason: "unavailable" | "protocol_mismatch"; pong?: import("@smithers-orchestrator/herdr").HerdrPong; error?: unknown }
 * >}
 */
export async function probeCompatibleHerdr(client) {
  try {
    const pong = await client.ping({ requireProtocolMatch: true });
    if (!pong) {
      return { available: false, reason: "unavailable" };
    }
    // Keep the helper safe for injected/older clients that accept but ignore
    // the strict option and still return an inspectable mismatched pong.
    if (pong.protocol !== HERDR_PROTOCOL) {
      return {
        available: false,
        reason: "protocol_mismatch",
        pong,
        error: new Error(`herdr protocol mismatch: client expects ${HERDR_PROTOCOL}, server reports ${pong.protocol}`),
      };
    }
    return { available: true, pong };
  } catch (error) {
    const candidate = /** @type {{ code?: unknown; cause?: unknown }} */ (error);
    if (candidate?.code === "protocol_mismatch") {
      const pong =
        candidate.cause && typeof candidate.cause === "object"
          ? /** @type {import("@smithers-orchestrator/herdr").HerdrPong} */ (candidate.cause)
          : undefined;
      return { available: false, reason: "protocol_mismatch", pong, error };
    }
    return { available: false, reason: "unavailable", error };
  }
}

/** @param {Awaited<ReturnType<typeof probeCompatibleHerdr>>} compatibility */
function protocolMismatchDetail(compatibility) {
  if (compatibility.available || compatibility.reason !== "protocol_mismatch") return undefined;
  return compatibility.error instanceof Error ? compatibility.error.message : "herdr protocol mismatch";
}

// The event types the surface maps to a pane action (`HERDR_SURFACE_EVENT_TYPES`)
// are imported from `@smithers-orchestrator/herdr` — the surface owns that list,
// so the follow loop can pre-filter rows against the SAME set the surface's
// `onEvent` switch handles (skipping every other row, chiefly the high-volume
// `NodeOutput` stream, BEFORE its `payloadJson` is parsed) with zero drift risk.

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve whether (and into which session) this run should mirror into herdr.
 * The `--herdr` flag wins; otherwise the `SMITHERS_HERDR` env var is honored so a
 * detached `-d` child (which inherits the parent's env) activates the mirror in
 * its own process. Returns `undefined` (no mirror), `true` (default session), or
 * a session name string.
 *
 * @param {boolean | string | undefined} flagValue the parsed `--herdr` option
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {true | string | undefined}
 */
export function resolveHerdrOption(flagValue, env = process.env) {
  if (flagValue !== undefined && flagValue !== false) {
    if (typeof flagValue === "string") {
      // `--herdr` (bare) is rewritten to `--herdr=true` in argv preprocessing
      // (rewriteBareHerdrFlagArgv) so it doesn't swallow the next flag; treat
      // the boolean-ish strings as the default session, not a session named
      // "true"/"false".
      if (flagValue === "" || flagValue === "true") {
        return true;
      }
      if (flagValue === "false") {
        return undefined;
      }
      return flagValue;
    }
    return true;
  }
  const envVal = env?.SMITHERS_HERDR;
  if (typeof envVal === "string" && envVal !== "" && envVal !== "0") {
    return envVal === "1" || envVal === "true" ? true : envVal;
  }
  return undefined;
}

/**
 * The session name carried by a resolved herdr option, or `undefined` for the
 * default session.
 *
 * @param {true | string | undefined} option
 * @returns {string | undefined}
 */
export function herdrSessionOf(option) {
  return typeof option === "string" ? option : undefined;
}

/**
 * The deterministic herdr workspace label for a run. This is the find-or-create
 * key, so `up --herdr` and `herdr attach` MUST derive it identically. The
 * versioned, encoded suffix is the ownership marker used before Smithers adopts
 * or destroys a workspace; ordinary multi-word Herdr labels never qualify.
 *
 * @param {string} workflowId
 * @param {string} runId
 * @returns {string}
 */
export function herdrWorkspaceLabel(workflowId, runId) {
  return `${workflowId} [smithers:v1:${encodeURIComponent(runId)}]`;
}

/**
 * The inverse of {@link herdrWorkspaceLabel}: pull the run id back out of a herdr
 * workspace label, tolerating the terminal-state outcome marker prefix
 * (`✓`/`✗`/`◻`) the surface prepends on finish. Only the canonical, versioned
 * Smithers ownership marker is accepted. Callers performing destructive work
 * must additionally compare the complete label with the identity reconstructed
 * from the run row.
 *
 * @param {string} label
 * @returns {string | undefined}
 */
export function herdrRunIdFromWorkspaceLabel(label) {
  if (typeof label !== "string" || label === "") {
    return undefined;
  }
  const base = stripOutcomeMarker(label);
  const marker = " [smithers:v1:";
  const markerStart = base.lastIndexOf(marker);
  if (markerStart <= 0 || !base.endsWith("]")) {
    return undefined;
  }
  const encodedRunId = base.slice(markerStart + marker.length, -1);
  if (encodedRunId === "") {
    return undefined;
  }
  try {
    const runId = decodeURIComponent(encodedRunId);
    const workflowId = base.slice(0, markerStart);
    return runId !== "" && herdrWorkspaceLabel(workflowId, runId) === base ? runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A herdr logger that writes soft-failure warnings to stderr (never stdout, so
 * command output stays clean). In a detached `-d` child, stderr is the detach log
 * file, so mirror warnings land there deliberately.
 *
 * @returns {import("@smithers-orchestrator/herdr").HerdrLogger}
 */
export function makeHerdrStderrLogger() {
  return (level, message, data) => {
    if (level !== "warn") {
      return;
    }
    let line = `[herdr] ${message}`;
    if (data !== undefined) {
      try {
        line += ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
      } catch {
        // non-serializable detail: drop it, keep the message
      }
    }
    process.stderr.write(`${line}\n`);
  };
}

/**
 * The argv a herdr tail pane runs. Built from the CLI's own invocation (the same
 * `bun <cli-entry>` mechanics as the detached-run spawn), so it works in a dev
 * checkout — the default `["smithers", "tail", ...]` only resolves for a global
 * install. Uses the absolute interpreter + entry path so it is independent of the
 * herdr pane's PATH; the pane inherits the workspace cwd (where the run's DB is)
 * so `smithers tail` finds the store.
 *
 * The pane passes `--linger` so it stays open on a terminal run state (the human
 * can come back and read what happened) instead of exiting the instant the run
 * finishes and letting herdr tear the pane down. This mirrors the surface's
 * default tail command; a plain interactive `smithers tail` keeps the default
 * exit-on-terminal behavior.
 *
 * @param {string} cliPath absolute path to the CLI entry (this process's entry)
 * @returns {(ctx: { runId: string, nodeId: string }) => string[]}
 */
/**
 * @param {string} cliPath absolute path to the CLI entry (this process's entry)
 * @param {{ dbPath?: string }} [opts] optional absolute smithers.db path for detail panes
 * @returns {(ctx: { runId: string, nodeId: string }) => string[]}
 */
export function buildTailCommand(cliPath, opts = {}) {
  // Prefer the thin node-detail entry (fast first paint for supervisor Enter).
  // Full `index.js tail` cold-starts ~1.2s; thin entry avoids the whole CLI surface.
  const thinEntry = join(dirname(cliPath), "node-detail-entry.js");
  const dbPath = typeof opts.dbPath === "string" && opts.dbPath.endsWith("smithers.db") ? opts.dbPath : undefined;
  if (existsSync(thinEntry)) {
    return (ctx) => {
      /** @type {string[]} */
      const argv = [process.execPath, thinEntry, ctx.runId, "--node", ctx.nodeId, "--linger"];
      // Pin the store the supervisor is reading so mid-run opens cannot
      // resolve a different/empty smithers.db via cwd walk.
      if (dbPath) argv.push("--db", dbPath);
      return argv;
    };
  }

  // Fallback: full CLI tail + HUD dock (s steer · h hijack · q).
  // Note: `smithers tail` has no `--db` flag — relies on cwd discovery.
  return (ctx) => [process.execPath, cliPath, "tail", ctx.runId, "--node", ctx.nodeId, "--hud", "--linger"];
}

/**
 * The argv a herdr APPROVAL GATE pane runs: the interactive `approve --watch`
 * loop, scoped to the gate's node, so the human answers the gate (and any human
 * request on that node) directly in the pane instead of just reading a tail. Built
 * from this process's own interpreter + entry path (same mechanics as
 * {@link buildTailCommand}) so it resolves in a dev checkout. The pane inherits the
 * workspace cwd (where the run's DB is) so the watch loop finds the store. The
 * watch loop lingers on a terminal run state itself, so no `--linger` is needed.
 *
 * @param {string} cliPath absolute path to the CLI entry (this process's entry)
 * @returns {(ctx: { runId: string, nodeId: string }) => string[]}
 */
export function buildGateCommand(cliPath) {
  return (ctx) => [process.execPath, cliPath, "approve", ctx.runId, "--watch", "--node", ctx.nodeId];
}

/**
 * Long-lived workflow supervisor for the herdr cockpit right pane.
 * Uses `smithers supervisor` (not per-run `tail`) so the pane is a single process
 * that discovers runs in the workspace DB as they appear. Prefer absolute `--db`
 * so the pane does not depend on herdr's cwd / findSmithersDb walk.
 *
 * @param {string} cliPath absolute path to the CLI entry (this process's entry)
 * @param {{ dbPath?: string, cwd?: string }} [opts]
 * @returns {(ctx: { runId: string }) => string[]}
 */
export function buildOverviewCommand(cliPath, opts = {}) {
  /** @type {string[]} */
  const argv = [process.execPath, cliPath, "supervisor"];
  if (typeof opts.dbPath === "string" && opts.dbPath !== "") {
    argv.push("--db", opts.dbPath);
  }
  if (typeof opts.cwd === "string" && opts.cwd !== "") {
    argv.push("--cwd", opts.cwd);
  }
  return (_ctx) => [...argv];
}

/**
 * @param {string | null | undefined} metaJson
 * @returns {Record<string, unknown>}
 */
function parseMetaJson(metaJson) {
  if (typeof metaJson !== "string" || metaJson === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Build the surface `nodeFilter`: mirror only nodes whose attempt was recorded
 * with `metaJson.kind === "agent"` (compute/static nodes get no pane). The
 * discriminator is race-free — the engine commits the attempt row (with `kind`)
 * before it emits `NodeStarted` — so the row is present by the time the surface
 * asks. Cached per nodeId. Soft: a transient DB error resolves to `undefined`
 * (the surface's "unknown" channel), NOT `false`, so the read is retried on the
 * node's NEXT event instead of freezing the node as "not an agent" forever
 * (a cached `false` would permanently suppress the node's pane — the surface
 * memoizes a boolean decision but re-asks on `undefined`). Only a decision
 * derived from a successful read is memoized here.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} runId
 * @returns {(ctx: { runId: string, nodeId: string }) => Promise<boolean | undefined>}
 */
export function buildAgentNodeFilter(adapter, runId) {
  /** @type {Map<string, boolean>} */
  const cache = new Map();
  return async ({ nodeId }) => {
    const cached = cache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const attempts = await adapter.listAttemptsForRun(runId);
      const row = Array.isArray(attempts) ? attempts.find((a) => a && a.nodeId === nodeId) : undefined;
      const isAgent = parseMetaJson(row?.metaJson).kind === "agent";
      // Only memoize a decision derived from a successful read.
      cache.set(nodeId, isAgent);
      return isAgent;
    } catch {
      // Transient DB error → the surface's "unknown" channel: return undefined
      // (never cached) so the node's next event re-asks, instead of a sticky
      // `false` that would suppress the pane for the rest of the run.
      return undefined;
    }
  };
}

/**
 * Whether a workflow entry file is marked `// smithers-system: true` (or
 * frontmatter `system: true`). Used to suppress env-inherited herdr mirroring for
 * internal plumbing (post-failure, init, …). Soft: unreadable files → false.
 *
 * @param {string | undefined} workflowPath
 * @returns {boolean}
 */
export function isSystemWorkflowSource(workflowPath) {
  if (typeof workflowPath !== "string" || workflowPath === "") {
    return false;
  }
  try {
    const head = readFileSync(workflowPath, "utf8").slice(0, 4000);
    if (/smithers-system\s*:\s*true/i.test(head)) {
      return true;
    }
    if (/(?:^|\n)\s*system\s*:\s*true\b/m.test(head)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Normalize declarative / CLI herdr cockpit options (workflow.opts.herdr).
 *
 * @param {Record<string, unknown> | undefined | null} raw
 * @returns {{
 *   pin?: string[];
 *   softPinSlots?: number;
 *   tabCap?: number;
 *   autoOpen?: { stage?: boolean; workers?: boolean; gates?: boolean; failures?: boolean };
 *   sessionName?: string;
 *   surface?: string;
 * }}
 */
export function normalizeHerdrCockpitOpts(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  /** @type {ReturnType<typeof normalizeHerdrCockpitOpts>} */
  const out = {};
  if (Array.isArray(raw.pin)) {
    out.pin = raw.pin.filter((p) => typeof p === "string");
  }
  if (typeof raw.softPinSlots === "number" && Number.isFinite(raw.softPinSlots)) {
    out.softPinSlots = raw.softPinSlots;
  }
  if (typeof raw.tabCap === "number" && Number.isFinite(raw.tabCap) && raw.tabCap > 0) {
    out.tabCap = Math.floor(raw.tabCap);
  }
  if (raw.autoOpen && typeof raw.autoOpen === "object") {
    out.autoOpen = /** @type {any} */ (raw.autoOpen);
  }
  if (typeof raw.sessionName === "string" && raw.sessionName !== "") {
    out.sessionName = raw.sessionName;
  }
  if (typeof raw.surface === "string" && raw.surface !== "") {
    out.surface = raw.surface;
  }
  if (raw.chrome === "split" || raw.chrome === "tabs" || raw.chrome === "auto") {
    out.chrome = raw.chrome;
  }
  if (raw.harnessCommand !== undefined) {
    out.harnessCommand = /** @type {any} */ (raw.harnessCommand);
  }
  if (typeof raw.dock === "boolean") {
    out.dock = raw.dock;
  }
  return out;
}

/**
 * Build a herdr run surface for `smithers up --herdr`, wired from the CLI's
 * onProgress seam. Probes the server first with a SILENT client so an absent
 * herdr warns exactly once (this function's line) and returns `null` — the caller
 * then runs normally with no mirror. When the server is reachable, the surface
 * carries the deterministic label, real pane commands (`smithers supervisor`
 * for the workflow supervisor board, `tail --node` for detail), an agent-only
 * node filter, cockpit soft-pin policy, and a stderr logger. Never closes the
 * workspace on finish (left for humans).
 *
 * The right pane of the herdr **cockpit** tab runs
 * `smithers supervisor --db <store>` (workflow supervisor).
 *
 * @param {{
 *   session: string | undefined;
 *   label: string;
 *   cwd?: string;
 *   /** Absolute path to smithers.db when known (passed to `supervisor --db`). *\/
 *   dbPath?: string;
 *   adapter: any;
 *   runId: string;
 *   cliPath: string;
 *   logger?: import("@smithers-orchestrator/herdr").HerdrLogger;
 *   cockpit?: ReturnType<typeof normalizeHerdrCockpitOpts>;
 *   client?: import("@smithers-orchestrator/herdr").HerdrClient;
 * }} params
 * @returns {Promise<import("@smithers-orchestrator/herdr").HerdrRunSurface | null>}
 */
export async function createUpHerdrSurface(params) {
  const log = params.logger ?? makeHerdrStderrLogger();
  const probe = params.client ?? createHerdrClient({ session: params.session, logger: () => {} });
  const compatibility = await probeCompatibleHerdr(probe);
  if (!compatibility.available) {
    const mismatch = protocolMismatchDetail(compatibility);
    log(
      "warn",
      mismatch
        ? `${mismatch}; running without the herdr mirror`
        : `--herdr requested but no herdr server is reachable at ${probe.socketPath}; running without the herdr mirror`,
    );
    return null;
  }
  const cockpit = params.cockpit ?? {};
  // Product default: auto chrome + auto harness (dock when HERDR_ENV=1, else
  // spawn grok/claude/… on the left when available; overview on the right).
  // Resolve dock to a boolean here so multi-run up --herdr never silently
  // steals the focused workspace (was: dock:true by default).
  const env = process.env;
  const envWantsDock = env.HERDR_ENV === "1" || env.SMITHERS_HERDR_DOCK === "1" || env.SMITHERS_HERDR_DOCK === "true";
  const dock = cockpit.dock === true ? true : cockpit.dock === false ? false : envWantsDock;
  const chrome = cockpit.chrome ?? "auto";
  const harnessCommand = cockpit.harnessCommand !== undefined ? cockpit.harnessCommand : "auto";
  return createHerdrRunSurface({
    client: probe,
    session: params.session,
    workspaceLabel: params.label,
    cwd: params.cwd,
    logger: log,
    // Pin --db on detail/tail panes so herdr tabs never re-discover (or
    // scaffold) a store from the tab's cwd.
    tailCommand: buildTailCommand(params.cliPath, { dbPath: params.dbPath }),
    gateCommand: buildGateCommand(params.cliPath),
    overviewCommand: buildOverviewCommand(params.cliPath, {
      dbPath: params.dbPath,
      cwd: params.cwd,
    }),
    nodeFilter: buildAgentNodeFilter(params.adapter, params.runId),
    closeWorkspaceOnFinish: false,
    pin: cockpit.pin,
    softPinSlots: cockpit.softPinSlots,
    tabCap: cockpit.tabCap,
    autoOpen: cockpit.autoOpen,
    chrome,
    harnessCommand,
    dock,
  });
}

/**
 * Best-effort daily-session stub when using session-per-run: a pointer workspace
 * in the default session so the operator is not blind. Soft-fails entirely.
 *
 * @param {{
 *   workflowId: string;
 *   runId: string;
 *   sessionName: string;
 *   cwd?: string;
 *   logger?: import("@smithers-orchestrator/herdr").HerdrLogger;
 *   client?: import("@smithers-orchestrator/herdr").HerdrClient;
 * }} params
 * @returns {Promise<void>}
 */
export async function ensureSessionStubWorkspace(params) {
  const log = params.logger ?? makeHerdrStderrLogger();
  try {
    const client = params.client ?? createHerdrClient({ logger: () => {} });
    const compatibility = await probeCompatibleHerdr(client);
    if (!compatibility.available) {
      const mismatch = protocolMismatchDetail(compatibility);
      if (mismatch) {
        log("warn", `${mismatch}; skipping the default-session mirror stub`);
      }
      return;
    }
    const label = stubWorkspaceLabel(params.workflowId, params.runId, params.sessionName);
    const list = /** @type {{ workspaces?: any[] } | undefined} */ (await client.tryCall("workspace.list", {}));
    const exists = list && Array.isArray(list.workspaces) && list.workspaces.some((w) => w && w.label === label);
    if (exists) {
      return;
    }
    const created = /** @type {{ root_pane?: { pane_id?: string } } | undefined} */ (
      await client.tryCall("workspace.create", {
        label,
        focus: false,
        cwd: params.cwd,
      })
    );
    const paneId = created?.root_pane?.pane_id;
    if (typeof paneId === "string") {
      const hint = sessionAttachHint({
        sessionName: params.sessionName,
        runId: params.runId,
      });
      await client.tryCall("pane.send_text", {
        pane_id: paneId,
        text: `printf '%s\\n' ${quotePosixShellArgument(hint)}\n`,
      });
    }
  } catch (err) {
    log("warn", `herdr session stub failed (soft): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reconstruct the surface event for a persisted event row. `payloadJson` is the
 * full serialized `SmithersEvent` (the engine stores `JSON.stringify(event)`), so
 * parsing it yields every field the surface reads (`error`, `event`, `request`,
 * `failedChildren`, ...). Row columns are overlaid defensively.
 *
 * @param {any} row
 * @returns {import("@smithers-orchestrator/herdr").SmithersEventLike | undefined}
 */
function surfaceEventFromRow(row) {
  const payload = parseMetaJson(row?.payloadJson);
  const type = typeof payload.type === "string" ? payload.type : row?.type;
  if (typeof type !== "string") {
    return undefined;
  }
  return {
    ...payload,
    type,
    runId: typeof payload.runId === "string" ? payload.runId : row?.runId,
    nodeId: typeof payload.nodeId === "string" ? payload.nodeId : row?.nodeId,
  };
}

/**
 * Parse an approval row's `requestJson` into the `{ title, summary }` slice the
 * herdr surface renders as a blocked-pane message (its `approvalMessage` reads
 * exactly those two fields). Returns `undefined` when the JSON is absent /
 * unparseable / carries neither, so the caller falls back to the generic text.
 *
 * @param {string | null | undefined} requestJson
 * @returns {{ title?: string, summary?: string } | undefined}
 */
function parseApprovalRequest(requestJson) {
  if (typeof requestJson !== "string" || requestJson === "") {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  /** @type {{ title?: string, summary?: string }} */
  const request = {};
  if (typeof parsed.title === "string" && parsed.title !== "") {
    request.title = parsed.title;
  }
  if (typeof parsed.summary === "string" && parsed.summary !== "") {
    request.summary = parsed.summary;
  }
  return request.title || request.summary ? request : undefined;
}

/**
 * A synthetic surface event capturing a node's CURRENT state at attach time, so
 * the mirror reflects still-active nodes without replaying their whole history
 * (which would spin up panes for long-finished nodes). Only nodes that have
 * actually started AND are not terminal get an event; pending / finished / failed
 * / cancelled / skipped nodes get none.
 *
 * @param {any} node NodeRow
 * @param {string} runId
 * @param {{ title?: string, summary?: string }} [approvalRequest] enriches a
 *   `waiting-approval` node's blocked message with the real gate question.
 * @returns {import("@smithers-orchestrator/herdr").SmithersEventLike | undefined}
 */
function synthNodeStateEvent(node, runId, approvalRequest) {
  const base = {
    runId,
    nodeId: node.nodeId,
    iteration: typeof node.iteration === "number" ? node.iteration : 0,
    attempt: typeof node.lastAttempt === "number" ? node.lastAttempt : 1,
    timestampMs: Date.now(),
  };
  switch (node.state) {
    case "in-progress":
    case "waiting-timer":
    case "waiting-event":
      return { ...base, type: "NodeStarted" };
    case "waiting-approval":
      // Carry the parsed gate request when available so the adopted pane shows
      // the real approval question instead of the generic "waiting for approval".
      return approvalRequest
        ? { ...base, type: "NodeWaitingApproval", request: approvalRequest }
        : { ...base, type: "NodeWaitingApproval" };
    default:
      // pending / finished / failed / cancelled / skipped: no live pane.
      return undefined;
  }
}

/**
 * Reconcile a resuming `smithers up --herdr` run against the herdr state a PRIOR
 * (now-exited) surface left behind. The default flow parks at a human approval
 * gate by EXITING (exit 3 = awaiting a decision), so the process that reported
 * the gate `blocked` is gone; the fresh surface driving the resume must re-adopt
 * that pane and re-flag the gate, or the pane sits stuck "blocked" forever even
 * after the run is approved and finished.
 *
 * Adopts every prior pane for the run (`attach`, filter-independent), then marks
 * each non-terminal approval-gate node (a node still to run that carries an
 * approval row) so its live resolution on this resume reads idle "approved"
 * rather than the "done" an agent node reports. Best-effort and read-only: a DB
 * read failure leaves the mirror as-is. Must be awaited BEFORE the resumed run
 * starts, so the adoption and gate marks are enqueued ahead of the live events.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} runId
 * @param {import("@smithers-orchestrator/herdr").HerdrRunSurface} surface
 * @returns {Promise<void>}
 */
export async function reconcileHerdrResumeGates(adapter, runId, surface) {
  await surface.attach(runId);
  /** @type {any[] | undefined} */
  let nodes;
  try {
    nodes = await adapter.listNodes(runId);
  } catch {
    // Soft: the mirror is optional; without the node list we simply skip
    // re-flagging gates (the adopted panes still resolve, as "done").
    return;
  }
  if (!Array.isArray(nodes)) {
    return;
  }
  for (const node of nodes) {
    if (!node || typeof node.nodeId !== "string") {
      continue;
    }
    // Only a node still to run can still resolve in the mirror; a terminal node
    // is already settled. A re-armed (approved) gate sits in `pending`; an
    // unapproved gate sits in `waiting-approval`.
    if (node.state !== "pending" && node.state !== "waiting-approval") {
      continue;
    }
    const iteration = typeof node.iteration === "number" ? node.iteration : 0;
    /** @type {any} */
    let approval;
    try {
      approval = await adapter.getApproval(runId, node.nodeId, iteration);
    } catch {
      continue;
    }
    // Only a node with an approval row is a human gate; agent/compute nodes have none.
    if (approval) {
      surface.markApprovalGate(node.nodeId);
    }
  }
}

/**
 * Attach a surface to an existing run and follow it live via the DB poller until
 * the run is terminal or the caller cancels (Ctrl-C). Reconciles against existing
 * herdr state (adopts prior panes), re-flags any adopted parked approval gate (so
 * a live approval resolves it idle "approved" rather than working -> done — the
 * NodeWaitingApproval handler's `!entry.paneId` self-flag cannot fire once attach
 * has adopted the pane, mirroring the `up --resume` reconcile path), replays the
 * CURRENT node states as synthetic events (still-active nodes only), then feeds
 * every new persisted event into the surface. Read-only against the store; never
 * closes herdr workspaces (the caller closes the surface, which only detaches).
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {any} run run row from adapter.getRun
 * @param {import("@smithers-orchestrator/herdr").HerdrRunSurface} surface
 * @param {{ pollIntervalMs?: number; isCancelled?: () => boolean }} [options]
 * @returns {Promise<string | undefined>} the final derived run status (or undefined if cancelled)
 */
export async function followRunIntoHerdr(adapter, run, surface, options = {}) {
  const runId = run.runId;
  const pollIntervalMs = options.pollIntervalMs ?? HERDR_FOLLOW_POLL_INTERVAL_MS;
  // Snapshot the event cursor BEFORE synthesizing states, so any event written
  // between now and the first poll is replayed (no gap, last-write-wins).
  const startSeq = await adapter.getLastEventSeq(runId);
  let lastSeq = typeof startSeq === "number" ? startSeq : -1;

  // Adopt existing panes (a prior surface incarnation), then replay current
  // node states so the adopted panes get a fresh authoritative status.
  await surface.attach(runId);
  const nodes = await adapter.listNodes(runId);
  // Only when the run is actually parked on a gate: pull the pending approval
  // rows once (the same store the approvals CLI reads) so an adopted
  // waiting-approval pane shows the real gate question, not the generic text.
  // Cheap and soft - any failure leaves the generic message.
  /** @type {Map<string, { title?: string, summary?: string }>} */
  const approvalRequestsByNode = new Map();
  if (Array.isArray(nodes) && nodes.some((n) => n && n.state === "waiting-approval")) {
    try {
      const pending = await adapter.listPendingApprovals(runId);
      if (Array.isArray(pending)) {
        for (const row of pending) {
          if (!row || typeof row.nodeId !== "string") {
            continue;
          }
          // A node in the pending-approvals list IS a human approval gate. Re-flag
          // it here — BEFORE the synth loop below emits its NodeWaitingApproval —
          // so its live resolution reports idle "approved". `attach()` above already
          // adopted the parked gate pane (entry.paneId set), which is precisely why
          // the NodeWaitingApproval handler's own gate-discriminator (`!entry.paneId`)
          // no longer fires; without this the adopted gate would resolve
          // working -> done, inconsistently with the `up --resume` path
          // (reconcileHerdrResumeGates does the same re-flag). Idempotent.
          surface.markApprovalGate(row.nodeId);
          if (approvalRequestsByNode.has(row.nodeId)) {
            continue;
          }
          const request = parseApprovalRequest(row.requestJson);
          if (request) {
            approvalRequestsByNode.set(row.nodeId, request);
          }
        }
      }
    } catch {
      // Enrichment is best-effort; the generic "waiting for approval" text stands.
    }
  }
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const event = synthNodeStateEvent(node, runId, approvalRequestsByNode.get(node.nodeId));
      if (event) {
        surface.onEvent(event);
      }
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function drainNewEvents() {
    while (true) {
      const page = await adapter.listEvents(runId, lastSeq, HERDR_EVENT_PAGE_SIZE);
      if (!Array.isArray(page) || page.length === 0) {
        return;
      }
      for (const row of page) {
        // Advance the cursor for EVERY row (including skipped ones) so the
        // follow loop never re-reads them.
        if (typeof row.seq === "number") {
          lastSeq = row.seq;
        }
        // Pre-filter on the row's type column before parsing: the surface maps
        // only a fixed set of event types, so skip the JSON.parse for the rest
        // (chiefly the high-volume NodeOutput rows).
        if (!HERDR_SURFACE_EVENT_TYPES.has(row?.type)) {
          continue;
        }
        const event = surfaceEventFromRow(row);
        if (event) {
          surface.onEvent(event);
        }
      }
      if (page.length < HERDR_EVENT_PAGE_SIZE) {
        return;
      }
    }
  }

  while (true) {
    if (options.isCancelled?.()) {
      return undefined;
    }
    await sleep(pollIntervalMs);
    await drainNewEvents();
    const currentRun = await adapter.getRun(runId);
    const status = deriveTailStatus(await computeRunStateFromRow(adapter, currentRun ?? run));
    if (!isTailActiveState(status)) {
      // Drain any events written between the last poll and the terminal
      // transition, then stop so the follow session ends cleanly.
      await drainNewEvents();
      return status;
    }
  }
}

/**
 * Whether `smithers hijack` should host the interactive session in a herdr pane
 * instead of the operator's current terminal, and in which session.
 *
 * Pane hosting is OPT-IN via `SMITHERS_HERDR_HIJACK` (`1` | `true` | `<session>`).
 * It is deliberately NOT the default even for a mirrored run: a herdr pane's
 * process is owned by herdr, not this command, and herdr's `pane_exited` event
 * carries no exit code, so pane hosting cannot faithfully reproduce the current
 * flow's resume-ONLY-on-clean-exit handback (auto-resuming after an aborted or
 * errored session would corrupt the run). Keeping the byte-identical
 * current-terminal flow as the default preserves that contract; in a pane the
 * operator resumes manually with the printed `smithers up ... --resume` command.
 * When the toggle carries no explicit session, `SMITHERS_HERDR`'s session is used.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, session: string | undefined }}
 */
export function resolveHerdrHijackOption(env = process.env) {
  const raw = env?.SMITHERS_HERDR_HIJACK;
  if (typeof raw !== "string" || raw === "" || raw === "0" || raw === "false") {
    return { enabled: false, session: undefined };
  }
  if (raw !== "1" && raw !== "true") {
    return { enabled: true, session: raw };
  }
  return { enabled: true, session: herdrSessionOf(resolveHerdrOption(undefined, env)) };
}

/**
 * Single-quote a token for safe embedding inside a POSIX `sh -c` script literal.
 *
 * @param {string} s
 * @returns {string}
 */
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a hijack `HijackLaunchSpec` so that, in a herdr pane, the interactive agent
 * session's exit does NOT drop the pane to a bare shell (or tear the pane down):
 * after the session exits, the pane prints a handback summary (how to return
 * control to Smithers) and lingers for a keypress before exiting with the agent's
 * own exit code. The original command runs verbatim via `sh -c '"$@"' … <cmd> …`
 * (argv preserved exactly), inheriting the pane's PTY as an interactive TTY, and
 * the wrapper adds NO environment variables — `cwd`/`env` are passed through
 * unchanged so the agent session sees the exact same context it would have
 * un-wrapped. On a real terminal (TTY) it reads a single keypress via `stty`; with
 * a non-TTY stdin it falls back to a line read, so the wrapper is exercisable
 * without a PTY. This is applied ONLY on the herdr-pane path; the current-terminal
 * hijack flow (`launchHijackSession`) is left byte-identical.
 *
 * @param {import("./HijackLaunchSpec.ts").HijackLaunchSpec} spec
 * @param {string[]} handbackLines lines printed after the session exits (before the linger prompt)
 * @returns {import("./HijackLaunchSpec.ts").HijackLaunchSpec}
 */
export function wrapHijackPaneAfterlife(spec, handbackLines) {
  const lines = Array.isArray(handbackLines) ? handbackLines : [];
  const handbackEcho = lines.map((line) => `printf '%s\\n' ${shSingleQuote(line)}`).join("\n");
  const prompt = "[smithers] press any key to close this pane…";
  const script = [
    // Run the real agent command with its exact argv ($@ starts at $1).
    '"$@"',
    "__smithers_code=$?",
    "printf '\\n'",
    handbackEcho,
    `printf '%s' ${shSingleQuote(prompt)}`,
    // Linger for a keypress: a single byte in raw mode on a TTY, else a line read.
    "if [ -t 0 ]; then",
    "  __smithers_stty=$(stty -g 2>/dev/null || true)",
    "  stty -icanon -echo min 1 time 0 2>/dev/null || true",
    "  dd bs=1 count=1 >/dev/null 2>&1 || true",
    '  if [ -n "$__smithers_stty" ]; then stty "$__smithers_stty" 2>/dev/null || true; fi',
    "else",
    "  read __smithers_ignored",
    "fi",
    "printf '\\n'",
    "exit $__smithers_code",
  ]
    .filter((part) => part !== "")
    .join("\n");
  return {
    command: "sh",
    // `sh -c <script> <$0> <cmd> <args...>`: $0 is a label, $@ is `<cmd> <args...>`.
    args: ["-c", script, "smithers-hijack", spec.command, ...(Array.isArray(spec.args) ? spec.args : [])],
    // Preserve cwd/env EXACTLY — the wrapper adds nothing to the agent's context.
    cwd: spec.cwd,
    env: spec.env,
  };
}

/**
 * Host a hijack session in a herdr pane (spec D4) instead of the operator's
 * current terminal. Resolves the run's herdr workspace via the surface's
 * find-or-create label (`surface.workspaceId()`) so the hijack pane lands
 * alongside the run's mirror panes under the SAME deterministic label
 * `up --herdr` / `herdr attach` use, launches the `HijackLaunchSpec` into a pane
 * (`launchHijackPane` -> `agent.start`, marked `blocked`), and returns where it
 * landed so the caller can print the agent name and `herdr agent attach <name>`.
 *
 * Fully soft: probes the server first and returns `null` on any failure (no
 * server reachable, launch failed) so the caller falls back to the byte-identical
 * current-terminal flow.
 *
 * TODO(handback): automatic resume-on-clean-exit is intentionally NOT wired here.
 * The pane's process is owned by herdr and its `pane_exited` event carries no exit
 * code, so we cannot safely reproduce the current flow's resume-only-on-clean-exit
 * contract (auto-resuming after an aborted/errored session would corrupt the run),
 * and blocking this command on the pane for the whole takeover would defeat the
 * detach-and-attach-elsewhere ergonomics that motivate pane hosting. The operator
 * hands control back manually with the run's resume command. A future seam:
 * subscribe to `pane_exited` for `paneId` and, gated on a verified clean-exit
 * signal, call `resumeRunDetached`.
 *
 * @param {{
 *   spec: import("./HijackLaunchSpec.ts").HijackLaunchSpec;
 *   runId: string;
 *   nodeId: string;
 *   label?: string;
 *   session?: string | undefined;
 *   cwd?: string;
 *   resumeCommand?: string | null;
 *   logger?: import("@smithers-orchestrator/herdr").HerdrLogger;
 *   client?: import("@smithers-orchestrator/herdr").HerdrClient;
 * }} params
 * @returns {Promise<{ name: string, paneId: string, workspaceId: string | undefined } | null>}
 */
export async function launchHerdrHijackPane(params) {
  const log = params.logger ?? makeHerdrStderrLogger();
  const client = params.client ?? createHerdrClient({ session: params.session, logger: () => {} });
  const compatibility = await probeCompatibleHerdr(client);
  if (!compatibility.available) {
    const mismatch = protocolMismatchDetail(compatibility);
    log(
      "warn",
      mismatch
        ? `${mismatch}; hijacking in the current terminal`
        : `SMITHERS_HERDR_HIJACK set but no herdr server is reachable at ${client.socketPath}; hijacking in the current terminal`,
    );
    return null;
  }
  // Prefer the operator's CURRENT herdr workspace only when we are actually
  // inside a herdr pane (HERDR_ENV=1). Bare HERDR_WORKSPACE_ID inheritance from
  // a parent shell must not redirect pane-hosted hijacks into the wrong
  // workspace (e2e and scripted hijack set HERDR_ENV=0 on purpose).
  /** @type {string | undefined} */
  let workspaceId =
    process.env.HERDR_ENV === "1" &&
    typeof process.env.HERDR_WORKSPACE_ID === "string" &&
    process.env.HERDR_WORKSPACE_ID !== ""
      ? process.env.HERDR_WORKSPACE_ID
      : undefined;
  if (!workspaceId && params.label) {
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: params.label,
      cwd: params.cwd,
      logger: log,
    });
    try {
      await surface.attach(params.runId);
      workspaceId = await surface.workspaceId();
    } finally {
      // This surface is a throwaway resolver: drain its queued work so nothing
      // dangles. closeWorkspaceOnFinish defaults false, so close() only detaches -
      // it never closes the run's workspace (the hijack pane must land in it).
      await surface.close();
    }
  }
  // Wrap the launch spec so the pane survives the interactive session's exit with
  // a handback summary + keypress linger instead of collapsing to a bare shell
  // (the pane's process is herdr-owned; handback is manual, see the TODO above).
  const handbackLines = ["", "[smithers] hijack session ended."];
  if (params.resumeCommand) {
    handbackLines.push("[smithers] return control to Smithers with:");
    handbackLines.push(`  ${params.resumeCommand}`);
  } else {
    handbackLines.push("[smithers] resume the run from Smithers to return control.");
  }
  const wrappedSpec = wrapHijackPaneAfterlife(params.spec, handbackLines);
  const result = await launchHijackPane(client, wrappedSpec, {
    runId: params.runId,
    nodeId: params.nodeId,
    workspaceId,
    focus: true,
  });
  if (!result) {
    log("warn", "herdr hijack pane launch failed; hijacking in the current terminal");
    return null;
  }
  // The agent name is the surface's single source of truth (returned by
  // launchHijackPane) - do not re-derive it here.
  return {
    name: result.name,
    paneId: result.paneId,
    workspaceId: result.workspaceId,
  };
}

/**
 * Open (or re-open) an on-demand herdr pane for a run's NODE — or, when `nodeId`
 * is omitted, the run-level OVERVIEW — into the run's mirror workspace. Backs
 * `smithers herdr open`: it gives a pane to a node the adaptive mirror never
 * paned (e.g. an unpaned swarm worker past the tab cap), or re-surfaces a finished
 * node's lingering output tail on demand. Reuses the run surface's find-or-create
 * (outcome-tolerant, so a terminal workspace renamed with an outcome marker is
 * re-adopted, not duplicated) plus the shared {@link openTabPane} placement/adopt
 * helper, so a node that already has a live pane is adopted (never duplicated) and
 * its tail is not re-run. Assumes the server was already probed reachable by the
 * caller; fully soft otherwise — resolves `null` on any failure.
 *
 * @param {{
 *   session?: string | undefined;
 *   label: string;
 *   cwd?: string;
 *   runId: string;
 *   nodeId?: string;
 *   argv: string[];
 *   logger?: import("@smithers-orchestrator/herdr").HerdrLogger;
 *   client?: import("@smithers-orchestrator/herdr").HerdrClient;
 * }} params
 * @returns {Promise<{ name: string, paneId: string, workspaceId: string | undefined, tabLabel: string, nodeId: string | undefined } | null>}
 */
export async function openHerdrNodePane(params) {
  const log = params.logger ?? makeHerdrStderrLogger();
  if (!Array.isArray(params.argv) || params.argv.length === 0) {
    return null;
  }
  const client = params.client ?? createHerdrClient({ session: params.session, logger: () => {} });
  const compatibility = await probeCompatibleHerdr(client);
  if (!compatibility.available) {
    const mismatch = protocolMismatchDetail(compatibility);
    log(
      "warn",
      mismatch
        ? `${mismatch}; no workspace or pane was opened`
        : `herdr open: no server is reachable at ${client.socketPath}; no workspace or pane was opened`,
    );
    return null;
  }
  // Find-or-create the run's workspace via the surface API (same deterministic
  // label + outcome-tolerant exact matching `up --herdr` / `herdr attach` use), so an
  // on-demand pane lands in the run's own workspace instead of a stray one.
  /** @type {string | undefined} */
  let workspaceId;
  const surface = createHerdrRunSurface({
    client,
    workspaceLabel: params.label,
    cwd: params.cwd,
    logger: log,
    // Never dock on-demand open into the operator pane — always use the
    // deterministic labeled workspace for this run (isolation for multi-run
    // and for `herdr clean` / e2e).
    dock: false,
  });
  try {
    await surface.attach(params.runId);
    workspaceId = await surface.workspaceId();
  } finally {
    // Throwaway resolver: drain its queued work. closeWorkspaceOnFinish defaults
    // false, so close() only detaches — it never closes the run's workspace.
    await surface.close();
  }
  const nodeId = typeof params.nodeId === "string" && params.nodeId !== "" ? params.nodeId : undefined;
  const name = nodeId ? `smithers:${params.runId}:${nodeId}` : `smithers:${params.runId}:overview`;
  const tabLabel = nodeId ? shortNodeId(nodeId) : "overview";
  const opened = await openTabPane(client, {
    workspaceId,
    label: tabLabel,
    name,
    argv: params.argv,
    cwd: params.cwd,
    focus: false,
  });
  if (!opened) {
    log(
      "warn",
      `herdr open: could not place a pane for ${nodeId ? `node ${nodeId}` : "the overview"} of run ${params.runId}`,
    );
    return null;
  }
  return { name, paneId: opened.paneId, workspaceId: opened.workspaceId, tabLabel, nodeId };
}
