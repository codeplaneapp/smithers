import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SyntaxStyle } from "@opentui/core";
import { useApprovals, useActions, TUI_EVENT_CAP } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import { runNodeKey, type GatewayRunNode } from "@smthrs/gateway-client";
import {
  useRunInspectorVm,
  deriveOutputText,
  normalizeFrame,
  TUI_OUTPUT_PREVIEW_CHARS,
  TUI_OUTPUT_TRUNCATION_MARKER,
} from "@smthrs/ui-core";
import { RunTree, RunEventLog, sanitizeTerminalText, type RunTreeRow, type RunEventLogRow } from "@smthrs/tui-ui";
import {
  eventKeyName,
  isModifiedKeyEvent,
  treeScrollWindow,
  ALL_TABS,
  type FlatNode,
  type TabId,
} from "./treeUtils.ts";
import {
  approvalModeOf,
  approvalOptionsOf,
  approvalOptionWindow,
  modeHasOptions,
  buildApprovalDecision,
  runApprovalSubmit,
  claimInFlight,
  releaseInFlight,
  approvalRowKey,
  selectNodeApproval,
  pruneResolvedKeys,
  routeApprovalKey,
  type ApprovalMode,
  type ApprovalOption,
  type ApprovalDecision,
  type ApprovalKeyAction,
} from "./approvalUtils.ts";
import { buildHumanRequestUi, mayAwaitHumanInput, type HumanRequestUiState } from "./humanUtils.ts";
import { type NodeDiffView } from "./diffUtils.ts";
import { useOverlayOpen } from "../OverlayContext.tsx";

/**
 * Everything the inspector needs to render a pending approval and its controls.
 * `selectedKey` is the option the user has highlighted for a `select` (null for
 * gate/rank). Kept as a flat prop bag so the presentational view stays pure.
 */
export type ApprovalUiState = {
  title: string;
  summary?: string;
  mode: ApprovalMode;
  options: ApprovalOption[];
  selectedKey: string | null;
  busy: boolean;
  error: string | null;
};

const TAB_KEYS: Record<string, TabId> = {
  "1": "output",
  "2": "logs",
  "3": "diff",
  "4": "props",
};

let _syntaxStyle: SyntaxStyle | null = null;
function getPlainStyle(): SyntaxStyle {
  return (_syntaxStyle ??= SyntaxStyle.create());
}

const COMPACT_WIDTH = 100;

// Re-exported so existing test imports (`deriveOutputText`,
// `TUI_OUTPUT_PREVIEW_CHARS`, `TUI_OUTPUT_TRUNCATION_MARKER` from this module)
// keep working; the implementation lives in ui-core's useRunInspectorVm now
// (research/tui-parity/01-packages.md phase 2: "smithers-mon modes consume
// useRunInspectorVm").
export { deriveOutputText, TUI_OUTPUT_PREVIEW_CHARS, TUI_OUTPUT_TRUNCATION_MARKER };

// ─── Approval Banner ─────────────────────────────────────────────────────────

const MAX_OPTION_ROWS = 6;

function ApprovalBanner({ approval }: { approval: ApprovalUiState }) {
  const { title, summary, mode, options, selectedKey, busy, error } = approval;
  const safeTitle = sanitizeTerminalText(title);
  const safeSummary = summary ? sanitizeTerminalText(summary) : undefined;
  const safeError = error ? sanitizeTerminalText(error) : null;
  const showOptions = modeHasOptions(mode);
  // Window the rendered options around the highlighted one: `[`/`]` cycle
  // through ALL options, so a fixed 0-based slice would let the selection walk
  // off-screen (an invisible pick submitted on [a]). When the list overflows,
  // one row of the budget becomes a "+N more" indicator for select AND rank
  // (rank submits every option, so hidden entries must be announced).
  const selectedIdx =
    mode === "select" && selectedKey !== null
      ? Math.max(
          0,
          options.findIndex((o) => o.key === selectedKey),
        )
      : 0;
  const win = showOptions
    ? approvalOptionWindow(options.length, selectedIdx, MAX_OPTION_ROWS)
    : { start: 0, end: 0, hiddenCount: 0 };
  const optionRows = showOptions ? Math.min(options.length, MAX_OPTION_ROWS) : 0;
  // border(2) + title(1) + summary/error(1) + options (window + indicator) + controls(1)
  const height = 5 + optionRows;

  const controls = (() => {
    if (busy) return "submitting…";
    if (mode === "select") return "[[/]] choose   [a] approve selected   [d] deny";
    if (mode === "rank") return "[a] approve (ranked as listed)   [d] deny";
    return "[a] approve   [d] deny";
  })();

  return (
    <box
      width="100%"
      height={height}
      flexDirection="column"
      border={true}
      borderStyle="single"
      borderColor="#ffaf00"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#ffaf00">{`⏸  ${safeTitle}  [${mode}]`}</text>
      {safeError ? (
        <text fg="#ff5f5f">{`   ! ${safeError.slice(0, 60)}`}</text>
      ) : safeSummary ? (
        <text fg="#888888">{`   ${safeSummary}`}</text>
      ) : (
        <text fg="#555555">{"   awaiting your decision"}</text>
      )}
      {showOptions
        ? options.slice(win.start, win.end).map((opt, i) => {
            const absIdx = win.start + i;
            const isSel = mode === "select" && opt.key === selectedKey;
            // Rank numbering uses the ABSOLUTE position so a scrolled window
            // still shows the true submitted order.
            const prefix = mode === "rank" ? `${absIdx + 1}.` : isSel ? "›" : " ";
            return (
              <box key={opt.key} width="100%" height={1} flexDirection="row">
                <text fg={isSel ? "#ffaf00" : "#888888"}>{`   ${prefix} `}</text>
                <text fg={isSel ? "#ffffff" : "#cccccc"}>{sanitizeTerminalText(opt.label)}</text>
              </box>
            );
          })
        : null}
      {showOptions && win.hiddenCount > 0 ? (
        <box width="100%" height={1}>
          <text fg="#555555">{`   … +${win.hiddenCount} more (showing ${win.start + 1}-${win.end} of ${options.length})`}</text>
        </box>
      ) : null}
      <box width="100%" height={1}>
        <text fg={busy ? "#ffaf00" : "#888888"}>{controls}</text>
      </box>
    </box>
  );
}

// ─── Human Request Banner ─────────────────────────────────────────────────────

/**
 * Banner for a pending durable HumanTask. The gateway has no RPC to submit the
 * typed answer the task reads (only `smithers human` does), so instead of an
 * approve/deny control that would strand the run we tell the operator the exact
 * CLI to answer with. Presentational: all data arrives as a prop.
 */
function HumanRequestBanner({ human }: { human: HumanRequestUiState }) {
  const { title, prompt, runId } = human;
  const safeTitle = sanitizeTerminalText(title);
  const safePrompt = prompt ? sanitizeTerminalText(prompt) : undefined;
  const safeRunId = sanitizeTerminalText(runId);
  // border(2) + title(1) + prompt(1) + guidance(1)
  return (
    <box
      width="100%"
      height={5}
      flexDirection="column"
      border={true}
      borderStyle="single"
      borderColor="#ffaf00"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg="#ffaf00">{`⏸  ${safeTitle}  [human input]`}</text>
      {safePrompt ? (
        <text fg="#888888">{`   ${safePrompt.slice(0, 80)}`}</text>
      ) : (
        <text fg="#555555">{"   this step is waiting on a typed answer"}</text>
      )}
      <text fg="#00d7ff">{`   answer via CLI:  smithers human inbox   (run ${safeRunId})`}</text>
    </box>
  );
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

function TabBar({ activeTab }: { activeTab: TabId }) {
  return (
    <box width="100%" height={1} flexDirection="row">
      {ALL_TABS.map((t) => (
        <text key={t} fg={t === activeTab ? "#ffffff" : "#555555"} bg={t === activeTab ? "#333333" : undefined}>
          {` ${t} `}
        </text>
      ))}
    </box>
  );
}

// ─── Node Inspector (presentational) ──────────────────────────────────────────

/** Convert raw gateway frames into the tui-ui RunEventLog's row shape. */
function toRunEventLogRows(nodeLogs: readonly GatewayEventFrame[]): RunEventLogRow[] {
  return nodeLogs.map((e) => {
    const { event, payload } = normalizeFrame(e);
    return { seq: e.seq, event, payload: typeof payload === "string" ? payload : JSON.stringify(payload) };
  });
}

/**
 * Presentational node inspector. Takes ALL data as props (no gateway hooks) so
 * render tests can mount the REAL component the production wrapper uses, with
 * injected output / logs / diff / approval — they can't drift from production.
 */
export function NodeInspectorView({
  node,
  activeTab,
  outputText,
  nodeLogs,
  propsText,
  diff,
  diffLoading,
  approval,
  humanRequest,
}: {
  node: GatewayRunNode | null;
  activeTab: TabId;
  outputText: string;
  nodeLogs: GatewayEventFrame[];
  propsText: string;
  diff: NodeDiffView;
  diffLoading: boolean;
  approval: ApprovalUiState | null;
  humanRequest?: HumanRequestUiState | null;
}) {
  if (!node) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <text fg="#444444">{"  Select a node from the tree (j/k to move)"}</text>
      </box>
    );
  }

  const style = getPlainStyle();

  return (
    <box width="100%" height="100%" flexDirection="column">
      {humanRequest ? (
        <HumanRequestBanner human={humanRequest} />
      ) : approval ? (
        <ApprovalBanner approval={approval} />
      ) : null}
      <TabBar activeTab={activeTab} />
      <box width="100%" flexGrow={1}>
        {activeTab === "output" && (
          <scrollbox width="100%" height="100%" stickyScroll scrollY>
            <code width="100%" content={sanitizeTerminalText(outputText)} syntaxStyle={style} wrapMode="char" />
          </scrollbox>
        )}
        {activeTab === "logs" && (
          <RunEventLog rows={toRunEventLogRows(nodeLogs)} emptyLabel="no log events for this node" />
        )}
        {activeTab === "diff" && (
          <scrollbox width="100%" height="100%" scrollY>
            {diffLoading ? (
              <text fg="#888888">{"  Loading diff…"}</text>
            ) : diff.kind === "patch" ? (
              <box width="100%" flexDirection="column">
                <text fg="#888888">{`  ${sanitizeTerminalText(diff.summary)}`}</text>
                <code
                  width="100%"
                  content={sanitizeTerminalText(diff.unified)}
                  syntaxStyle={style}
                  filetype="diff"
                  wrapMode="char"
                />
              </box>
            ) : diff.kind === "stat" ? (
              <box width="100%" flexDirection="column">
                <text fg="#888888">{`  ${sanitizeTerminalText(diff.summary)}`}</text>
                <code width="100%" content={sanitizeTerminalText(diff.files)} syntaxStyle={style} wrapMode="char" />
              </box>
            ) : diff.kind === "error" ? (
              // A failed RPC (DiffTooLarge, dirty working tree, gateway down…)
              // is NOT "no diff" — surface it distinctly so the operator knows
              // a diff may exist but could not be fetched.
              <text fg="#ff5f5f" wrapMode="char">{`  Diff unavailable: ${sanitizeTerminalText(diff.message)}`}</text>
            ) : (
              <text fg="#444444">{`  ${sanitizeTerminalText(diff.message)}`}</text>
            )}
          </scrollbox>
        )}
        {activeTab === "props" && (
          <scrollbox width="100%" height="100%" scrollY>
            <code
              width="100%"
              content={sanitizeTerminalText(propsText)}
              syntaxStyle={style}
              filetype="json"
              wrapMode="char"
            />
          </scrollbox>
        )}
      </box>
    </box>
  );
}

// ─── Tree Panel ───────────────────────────────────────────────────────────────

/**
 * Presentational tree pane. Renders a SCROLL WINDOW of the flat rows that
 * follows `focusIdx` (see treeScrollWindow): a scrollbox never self-scrolls
 * without the renderer focus system, so j/k past the pane height used to walk
 * the highlight off-screen with no way to bring it back into view. `paneRows`
 * is the pane's height in rows; the window keeps the focused row visible with
 * context on both sides. Exported so render tests can drive the REAL pane with
 * an overflowing list. Delegates the actual row rendering to the tui-ui
 * `RunTree` leaf (research/tui-parity/01-packages.md "packages/tui-ui" phase 2).
 */
export function TreePanel({
  flat,
  focusIdx,
  panelWidth,
  paneRows,
}: {
  flat: FlatNode[];
  focusIdx: number;
  panelWidth: number;
  paneRows: number;
}) {
  const { start, end } = treeScrollWindow(flat.length, paneRows, focusIdx);
  const focused = flat[focusIdx];
  const rows: RunTreeRow[] = flat.slice(start, end).map(({ node, depth, hasChildren, isCollapsed }) => ({
    key: runNodeKey(node),
    depth,
    hasChildren,
    isCollapsed,
    status: node.status ?? "",
    label: node.cardLabel ?? node.name ?? node.id,
    meta: node.meta,
  }));

  return <RunTree rows={rows} focusedKey={focused ? runNodeKey(focused.node) : null} panelWidth={panelWidth} />;
}

// ─── Main TreeMode ────────────────────────────────────────────────────────────

export function TreeMode({ runId, initialSelectedNodeKey }: { runId: string; initialSelectedNodeKey?: string | null }) {
  // Tree flatten/collapse/focus, tab selection, and the focused node's
  // Output/Logs/Diff derivation are all owned by ui-core's shared view model
  // (research/tui-parity/01-packages.md phase 2: "smithers-mon modes consume
  // useRunInspectorVm"). Approval-banner state stays TreeMode-local for this
  // phase — see useRunInspectorVm's doc comment.
  const vm = useRunInspectorVm(runId, { initialSelectedNodeKey, maxEvents: TUI_EVENT_CAP });
  const { isLoading, error, flat, focusIdx, focusRow, toggleCollapsed, focusedNode, activeTab, setActiveTab } = vm;
  const { data: approvalsData, refetch: refetchApprovals } = useApprovals(runId);
  const actions = useActions();
  const { width, height } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const overlayOpen = useOverlayOpen();

  const [focusPane, setFocusPane] = useState<"tree" | "inspector">("tree");

  // Guards setState in async approval continuations that can resolve after a
  // mode switch unmounts this component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const approvals = approvalsData ?? [];

  // Approvals whose decision we submitted successfully but whose refetch hasn't
  // landed yet. We suppress them from the active banner SYNCHRONOUSLY on success
  // (see submitDecision) so a fast second [a]/[d] — after the in-flight guard
  // releases in onSettled but before the stale pending row disappears — can't
  // resubmit an already-decided gate. Pruned back to live rows once refetched.
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setResolvedKeys((prev) => pruneResolvedKeys(prev, approvals));
  }, [approvals]);

  const nodeApproval = selectNodeApproval(approvals, focusedNode, resolvedKeys);

  useEffect(() => {
    // Human-kind nodes can hold a pending request while the run itself is still
    // "running" (a parallel sibling keeps it un-parked), deriving a
    // non-"waiting" status like "queued" — so poll for their rows whenever the
    // node isn't settled (mayAwaitHumanInput), not just on "waiting".
    const waitsOnApproval =
      (focusedNode?.kind === "approval" && focusedNode.status === "waiting") || mayAwaitHumanInput(focusedNode);
    if (!waitsOnApproval || nodeApproval) return;
    let cancelled = false;
    const refetch = () => {
      if (!cancelled) void refetchApprovals().catch(() => {});
    };
    refetch();
    const interval = setInterval(refetch, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [focusedNode?.id, focusedNode?.iteration, focusedNode?.kind, focusedNode?.status, nodeApproval, refetchApprovals]);

  // Decode the approval's mode + options so we render mode-appropriate controls
  // and submit the right decision shape (gate vs select vs rank) — submitting a
  // bare `{ approved }` for a select/rank request would be rejected by the
  // gateway's validateApprovalDecision.
  const approvalMode = approvalModeOf(nodeApproval?.approvalMode);
  const approvalOptions = useMemo(() => approvalOptionsOf(nodeApproval?.options), [nodeApproval?.options]);

  // Highlighted option for a `select`. Reset to the first option whenever the
  // pending approval (node+iteration) changes so we never carry a stale pick.
  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null);
  const approvalKey = nodeApproval ? approvalRowKey(nodeApproval) : null;
  useEffect(() => {
    setSelectedOptionKey(approvalMode === "select" ? (approvalOptions[0]?.key ?? null) : null);
    // Re-seed on the identity of the pending request, not on every options array
    // recompute (which would fight the user's `[`/`]` navigation).
  }, [approvalKey, approvalMode]);

  // One in-flight decision at a time, keyed by the pending request, so a
  // double-press can't fire two submits and the UI can surface failures.
  const [pendingDecision, setPendingDecision] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const approvalBusy = pendingDecision !== null && pendingDecision === approvalKey;

  // SYNCHRONOUS dup-submit guard. `pendingDecision`/`approvalBusy` are React
  // state, so two key events handled in the same tick both see the stale "not
  // busy" value and would each fire a `submitApproval`. The ref flips
  // immediately, so the second claim in the same tick is rejected — one RPC.
  const inFlightRef = useRef<string | null>(null);

  const submitDecision = useCallback(
    (approved: boolean) => {
      if (!nodeApproval) return;
      const key = approvalRowKey(nodeApproval);
      const decision: ApprovalDecision | null = buildApprovalDecision(
        approvalMode,
        approved,
        approvalOptions,
        selectedOptionKey,
      );
      if (!decision) {
        // e.g. a select approve with no valid option chosen — refuse to send a
        // shape the gateway would reject, and tell the user why.
        setApprovalError("select an option before approving");
        return;
      }
      // Claim the in-flight slot BEFORE starting the promise; a second
      // synchronous press for the same request is dropped here.
      if (!claimInFlight(inFlightRef, key)) return;
      setPendingDecision(key);
      setApprovalError(null);
      void runApprovalSubmit({
        submit: () =>
          Promise.resolve(
            actions.submitApproval({
              runId,
              nodeId: nodeApproval.nodeId,
              iteration: nodeApproval.iteration,
              decision,
            }),
          ),
        // On success, suppress this row's banner/keys IMMEDIATELY (synchronously)
        // by marking its key resolved, then re-pull the approvals list so the row
        // leaves the pending set. The local suppression matters because the
        // in-flight guard releases in onSettled before the async refetch lands —
        // without it, a fast second [a]/[d] would resubmit an already-decided
        // request against the still-stale pending row.
        onSuccess: () => {
          if (!mountedRef.current) return;
          setResolvedKeys((prev) => {
            const next = new Set(prev);
            next.add(key);
            return next;
          });
          void refetchApprovals().catch(() => {});
        },
        onError: (err) => {
          if (mountedRef.current) setApprovalError(err instanceof Error ? err.message : String(err));
        },
        onSettled: () => {
          // Release the synchronous guard first (always), then clear the React
          // busy state if still mounted.
          releaseInFlight(inFlightRef, key);
          if (mountedRef.current) setPendingDecision((cur) => (cur === key ? null : cur));
        },
      });
    },
    [nodeApproval, runId, actions, approvalMode, approvalOptions, selectedOptionKey, refetchApprovals],
  );

  const handleApprove = useCallback(() => submitDecision(true), [submitDecision]);
  const handleDeny = useCallback(() => submitDecision(false), [submitDecision]);

  // Cycle the highlighted option for a `select` (the gate/rank modes have no
  // per-option pick — gate has none, rank submits the listed order).
  const cycleOption = useCallback(
    (dir: 1 | -1) => {
      if (approvalMode !== "select" || approvalOptions.length === 0) return;
      setSelectedOptionKey((cur) => {
        const idx = Math.max(
          0,
          approvalOptions.findIndex((o) => o.key === cur),
        );
        const next = (idx + dir + approvalOptions.length) % approvalOptions.length;
        return approvalOptions[next]?.key ?? cur;
      });
    },
    [approvalMode, approvalOptions],
  );

  // Dispatch a routed approval-banner action. Shared by both panes so the
  // banner's advertised a/d/[/] controls work wherever focus sits.
  const handleApprovalAction = useCallback(
    (action: ApprovalKeyAction) => {
      if (action.kind === "approve") handleApprove();
      else if (action.kind === "deny") handleDeny();
      else cycleOption(action.dir);
    },
    [handleApprove, handleDeny, cycleOption],
  );

  // A focused HumanTask with a pending request cannot be resolved from the
  // monitor: the gateway exposes no RPC to submit the typed answer the task
  // reads, and approving the gate alone leaves the run `waiting-approval` (see
  // humanUtils / the resume bridge). Surface CLI guidance and suppress the
  // approve/deny banner + keys so we never strand the run with a no-op decision.
  const humanRequestUi: HumanRequestUiState | null = buildHumanRequestUi(focusedNode, nodeApproval, runId);
  const isHumanRequest = humanRequestUi !== null;

  const approvalUi: ApprovalUiState | null =
    nodeApproval && !isHumanRequest
      ? {
          title: nodeApproval.requestTitle ?? "Approval required",
          summary: nodeApproval.requestSummary,
          mode: approvalMode,
          options: approvalOptions,
          selectedKey: selectedOptionKey,
          busy: approvalBusy,
          error: approvalError,
        }
      : null;

  useKeyboard((e) => {
    // Keys must not leak through an open help overlay, and ctrl/meta chords
    // must never reach the routing below: parseKeypress maps Ctrl-D to
    // { name: "d", ctrl: true }, so an unguarded handler would let a reflexive
    // Ctrl-D DENY (and Ctrl-A approve) a pending gate in one keystroke.
    if (overlayOpen || isModifiedKeyEvent(e)) return;
    const key = eventKeyName(e);

    if (key === "tab") {
      setFocusPane((p) => (p === "tree" ? "inspector" : "tree"));
      return;
    }
    if (key === "escape") {
      setFocusPane("tree");
      return;
    }

    // 1-4 switch NodeInspector tabs from anywhere in TREE mode
    if (key in TAB_KEYS) {
      setActiveTab(TAB_KEYS[key]!);
      return;
    }

    // Approval-banner controls (a/d approve|deny, [/] cycle a select's options)
    // are handled BEFORE the pane-specific branches so they fire regardless of
    // whether focus is in the tree or the inspector — the banner renders inside
    // the inspector, so its advertised keys must keep working once that pane is
    // focused (Tab/Enter). routeApprovalKey gates on pending/human/busy/mode.
    const approvalAction = routeApprovalKey(key, {
      hasApproval: nodeApproval !== undefined,
      isHumanRequest,
      mode: approvalMode,
      busy: approvalBusy,
    });
    if (approvalAction) {
      handleApprovalAction(approvalAction);
      return;
    }

    if (focusPane === "inspector") {
      if (key === "left") {
        const idx = ALL_TABS.indexOf(activeTab);
        setActiveTab(ALL_TABS[Math.max(0, idx - 1)] ?? activeTab);
      } else if (key === "right") {
        const idx = ALL_TABS.indexOf(activeTab);
        setActiveTab(ALL_TABS[Math.min(ALL_TABS.length - 1, idx + 1)] ?? activeTab);
      }
      return;
    }

    if (focusPane === "tree") {
      if (key === "j" || key === "down") {
        focusRow(Math.min(focusIdx + 1, Math.max(0, flat.length - 1)));
      } else if (key === "k" || key === "up") {
        focusRow(Math.max(focusIdx - 1, 0));
      } else if (key === "space") {
        const item = flat[focusIdx];
        if (item?.hasChildren) {
          // Collapse state is keyed by the unique row `key` (matches flattenTree),
          // so two attempts of the same logical node fold independently.
          toggleCollapsed(runNodeKey(item.node));
        }
      } else if (key === "return") {
        if (flat.length > 0) setFocusPane("inspector");
      }
    }
  });

  if (isLoading) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">{"  Loading run tree…"}</text>
      </box>
    );
  }

  if (error) {
    return (
      <box width="100%" height="100%">
        <text fg="#ff5f5f">{`  Error: ${sanitizeTerminalText(error.message)}`}</text>
      </box>
    );
  }

  const treePanelWidth = Math.floor(width * 0.38);

  // The tree pane's height in rows drives its scroll window: the mode body is
  // the terminal minus the header (1) and keybar (1); compact mode stacks the
  // tree above the inspector at half that. Passed explicitly (not "50%") so the
  // window math and the layout can't disagree by a rounding row.
  const bodyRows = Math.max(3, height - 2);
  const paneRows = compact ? Math.max(3, Math.floor(bodyRows / 2)) : bodyRows;

  const propsText = focusedNode
    ? JSON.stringify(
        {
          id: focusedNode.id,
          // `key` + `iteration` distinguish repeated logical nodes (loop/retry
          // attempts share `id` but get unique rows); essential when inspecting a
          // specific attempt.
          key: runNodeKey(focusedNode),
          iteration: focusedNode.iteration,
          name: focusedNode.name,
          kind: focusedNode.kind,
          status: focusedNode.status,
          agent: focusedNode.agent,
          meta: focusedNode.meta,
          cardLabel: focusedNode.cardLabel,
          parentId: focusedNode.parentId,
          childIds: focusedNode.childIds,
        },
        null,
        2,
      )
    : "";

  const inspector = (
    <NodeInspectorView
      node={focusedNode}
      activeTab={activeTab}
      outputText={vm.outputText}
      nodeLogs={vm.nodeLogs}
      propsText={propsText}
      diff={vm.diff}
      diffLoading={vm.diffLoading}
      approval={approvalUi}
      humanRequest={humanRequestUi}
    />
  );

  if (compact) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <box width="100%" height={paneRows}>
          <TreePanel flat={flat} focusIdx={focusIdx} panelWidth={Math.floor(width * 0.5)} paneRows={paneRows} />
        </box>
        <box width="100%" flexGrow={1}>
          {inspector}
        </box>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="row">
      <box width="38%" height="100%" border={["right"]} borderColor="#333333">
        <TreePanel flat={flat} focusIdx={focusIdx} panelWidth={treePanelWidth} paneRows={paneRows} />
      </box>
      <box width="62%" height="100%">
        {inspector}
      </box>
    </box>
  );
}
