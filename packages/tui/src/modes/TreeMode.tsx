import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SyntaxStyle } from "@opentui/core";
import { useRunTree, useApprovals, useRunEvents, useNodeDiff, useNodeOutput, useActions } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { normalizeFrame, nodeLogEvents } from "./eventFrame.ts";
import {
  flattenTree,
  nodeGlyph,
  nodeGlyphColor,
  nodeChevron,
  defaultTab,
  ALL_TABS,
  type FlatNode,
  type TabId,
} from "./treeUtils.ts";
import {
  approvalModeOf,
  approvalOptionsOf,
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
import { buildHumanRequestUi, type HumanRequestUiState } from "./humanUtils.ts";
import { toNodeDiffView, type NodeDiffView } from "./diffUtils.ts";

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

// ─── Approval Banner ─────────────────────────────────────────────────────────

const MAX_OPTION_ROWS = 6;

function ApprovalBanner({ approval }: { approval: ApprovalUiState }) {
  const { title, summary, mode, options, selectedKey, busy, error } = approval;
  const showOptions = modeHasOptions(mode);
  const optionRows = showOptions ? Math.min(options.length, MAX_OPTION_ROWS) : 0;
  // border(2) + title(1) + summary/error(1) + options + controls(1)
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
      <text fg="#ffaf00">{`⏸  ${title}  [${mode}]`}</text>
      {error ? (
        <text fg="#ff5f5f">{`   ! ${error.slice(0, 60)}`}</text>
      ) : summary ? (
        <text fg="#888888">{`   ${summary}`}</text>
      ) : (
        <text fg="#555555">{"   awaiting your decision"}</text>
      )}
      {showOptions
        ? options.slice(0, MAX_OPTION_ROWS).map((opt, i) => {
            const isSel = mode === "select" && opt.key === selectedKey;
            const prefix = mode === "rank" ? `${i + 1}.` : isSel ? "›" : " ";
            return (
              <box key={opt.key} width="100%" height={1} flexDirection="row">
                <text fg={isSel ? "#ffaf00" : "#888888"}>{`   ${prefix} `}</text>
                <text fg={isSel ? "#ffffff" : "#cccccc"}>{opt.label}</text>
              </box>
            );
          })
        : null}
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
      <text fg="#ffaf00">{`⏸  ${title}  [human input]`}</text>
      {prompt ? (
        <text fg="#888888">{`   ${prompt.slice(0, 80)}`}</text>
      ) : (
        <text fg="#555555">{"   this step is waiting on a typed answer"}</text>
      )}
      <text fg="#00d7ff">{`   answer via CLI:  smithers human inbox   (run ${runId})`}</text>
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

function deriveOutputText(outputData: unknown, node: GatewayRunNode): string {
  if (outputData && typeof outputData === "object") {
    const d = outputData as Record<string, unknown>;
    if (typeof d["output"] === "string") return d["output"];
    if (typeof d["text"] === "string") return d["text"];
    if (typeof d["content"] === "string") return d["content"];
    return JSON.stringify(d, null, 2);
  }
  if (node.output) return String(node.output);
  return "(no output)";
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
            <code width="100%" content={outputText} syntaxStyle={style} wrapMode="char" />
          </scrollbox>
        )}
        {activeTab === "logs" && (
          <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom" scrollY>
            {nodeLogs.length === 0 ? (
              <text fg="#444444">{"  (no log events for this node)"}</text>
            ) : (
              nodeLogs.map((e, i) => {
                const { event, payload } = normalizeFrame(e);
                return (
                  <text key={i} fg="#888888" wrapMode="char">
                    {`  [${e.seq}] ${event}  ${typeof payload === "string" ? payload : JSON.stringify(payload)}`}
                  </text>
                );
              })
            )}
          </scrollbox>
        )}
        {activeTab === "diff" && (
          <scrollbox width="100%" height="100%" scrollY>
            {diffLoading ? (
              <text fg="#888888">{"  Loading diff…"}</text>
            ) : diff.kind === "patch" ? (
              <box width="100%" flexDirection="column">
                <text fg="#888888">{`  ${diff.summary}`}</text>
                <code width="100%" content={diff.unified} syntaxStyle={style} filetype="diff" wrapMode="char" />
              </box>
            ) : diff.kind === "stat" ? (
              <box width="100%" flexDirection="column">
                <text fg="#888888">{`  ${diff.summary}`}</text>
                <code width="100%" content={diff.files} syntaxStyle={style} wrapMode="char" />
              </box>
            ) : (
              <text fg="#444444">{`  ${diff.message}`}</text>
            )}
          </scrollbox>
        )}
        {activeTab === "props" && (
          <scrollbox width="100%" height="100%" scrollY>
            <code width="100%" content={propsText} syntaxStyle={style} filetype="json" wrapMode="char" />
          </scrollbox>
        )}
      </box>
    </box>
  );
}

// ─── Node Inspector (gateway-connected wrapper) ───────────────────────────────

function NodeInspector({
  runId,
  node,
  approval,
  humanRequest,
  activeTab,
}: {
  runId: string;
  node: GatewayRunNode | null;
  approval: ApprovalUiState | null;
  humanRequest: HumanRequestUiState | null;
  activeTab: TabId;
}) {
  const { events } = useRunEvents(runId);
  const { data: outputData } = useNodeOutput({ runId, nodeId: node?.id, iteration: node?.iteration });
  // Only the Diff tab needs the (potentially expensive) node diff; gate the RPC
  // on it so switching nodes/tabs doesn't fetch diffs nobody is looking at.
  const { data: diffData, loading: diffLoading } = useNodeDiff({
    runId,
    nodeId: activeTab === "diff" ? node?.id : undefined,
    iteration: node?.iteration,
  });

  if (!node) {
    return <NodeInspectorView node={null} activeTab={activeTab} outputText="" nodeLogs={[]} propsText="" diff={{ kind: "empty", message: "" }} diffLoading={false} approval={null} />;
  }

  // Iteration-aware so loop/retry attempts don't show mixed logs (node output
  // and approvals are already iteration-scoped); see nodeLogEvents.
  const nodeLogs = nodeLogEvents(events, node.id, node.iteration).slice(-500);
  const outputText = deriveOutputText(outputData, node);
  const propsText = JSON.stringify(
    {
      id: node.id,
      // `key` + `iteration` distinguish repeated logical nodes (loop/retry
      // attempts share `id` but get unique rows); essential when inspecting a
      // specific attempt.
      key: runNodeKey(node),
      iteration: node.iteration,
      name: node.name,
      kind: node.kind,
      status: node.status,
      agent: node.agent,
      meta: node.meta,
      cardLabel: node.cardLabel,
      parentId: node.parentId,
      childIds: node.childIds,
    },
    null,
    2,
  );
  return (
    <NodeInspectorView
      node={node}
      activeTab={activeTab}
      outputText={outputText}
      nodeLogs={nodeLogs}
      propsText={propsText}
      diff={toNodeDiffView(diffData)}
      diffLoading={activeTab === "diff" && diffLoading}
      approval={approval}
      humanRequest={humanRequest}
    />
  );
}

// ─── Tree Panel ───────────────────────────────────────────────────────────────

function TreePanel({
  flat,
  focusIdx,
  panelWidth,
}: {
  flat: FlatNode[];
  focusIdx: number;
  panelWidth: number;
}) {
  if (flat.length === 0) {
    return (
      <scrollbox width="100%" height="100%">
        <text fg="#444444">{"  (no nodes)"}</text>
      </scrollbox>
    );
  }

  return (
    <scrollbox width="100%" height="100%" scrollY>
      {flat.map(({ node, depth, hasChildren, isCollapsed }, i) => {
        const isFocused = i === focusIdx;
        const chevron = nodeChevron(hasChildren, isCollapsed);
        const glyph = nodeGlyph(node.status ?? "");
        const glyphColor = nodeGlyphColor(node.status ?? "");
        const label = node.cardLabel ?? node.name ?? node.id;
        const meta = node.meta ? ` ${node.meta}` : "";
        const indentWidth = depth * 2;
        const reservedWidth = indentWidth + 4 + meta.length;
        const maxLabelWidth = Math.max(8, panelWidth - reservedWidth);
        const truncLabel =
          label.length > maxLabelWidth ? label.slice(0, maxLabelWidth - 1) + "…" : label;

        return (
          <box
            key={runNodeKey(node)}
            width="100%"
            height={1}
            flexDirection="row"
            backgroundColor={isFocused ? "#1a1a2e" : undefined}
          >
            <text fg="#333333">{" ".repeat(indentWidth)}</text>
            <text fg="#555555">{chevron}</text>
            <text fg={glyphColor}>{` ${glyph} `}</text>
            <text fg={isFocused ? "#ffffff" : "#cccccc"}>{truncLabel}</text>
            {meta ? <text fg="#555555">{meta}</text> : null}
          </box>
        );
      })}
    </scrollbox>
  );
}

// ─── Main TreeMode ────────────────────────────────────────────────────────────

export function TreeMode({
  runId,
  initialSelectedNodeId,
}: {
  runId: string;
  initialSelectedNodeId?: string | null;
}) {
  const { root, nodes, isLoading, error } = useRunTree(runId);
  const { data: approvalsData, refetch: refetchApprovals } = useApprovals(runId);
  const actions = useActions();
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const [focusPane, setFocusPane] = useState<"tree" | "inspector">("tree");
  const [activeTab, setActiveTab] = useState<TabId>("props");

  const flat = useMemo(() => flattenTree(nodes, root, collapsed), [nodes, root, collapsed]);

  // When switching from Graph mode with a selected node, focus it — but only
  // once per selection. Reruns when `flat` changes so it still focuses if the
  // tree data arrives AFTER the mode switch, while a ref guard keeps later live
  // updates from yanking focus back off the user's manual j/k navigation.
  const focusedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialSelectedNodeId) return;
    if (focusedSelectionRef.current === initialSelectedNodeId) return;
    // Graph mode hands us a row `key` (unique per attempt), so match on `key`.
    const idx = flat.findIndex((f) => runNodeKey(f.node) === initialSelectedNodeId);
    if (idx >= 0) {
      setFocusIdx(idx);
      focusedSelectionRef.current = initialSelectedNodeId;
    }
  }, [initialSelectedNodeId, flat]);

  const safeIdx = flat.length > 0 ? Math.min(focusIdx, flat.length - 1) : 0;
  const focusedNode = flat[safeIdx]?.node ?? null;

  // Guards setState in async approval continuations that can resolve after a
  // mode switch unmounts this component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (focusedNode) setActiveTab(defaultTab(focusedNode));
  }, [focusedNode ? runNodeKey(focusedNode) : undefined]);

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

  // Decode the approval's mode + options so we render mode-appropriate controls
  // and submit the right decision shape (gate vs select vs rank) — submitting a
  // bare `{ approved }` for a select/rank request would be rejected by the
  // gateway's validateApprovalDecision.
  const approvalMode = approvalModeOf(nodeApproval?.approvalMode);
  const approvalOptions = useMemo(
    () => approvalOptionsOf(nodeApproval?.options),
    [nodeApproval?.options],
  );

  // Highlighted option for a `select`. Reset to the first option whenever the
  // pending approval (node+iteration) changes so we never carry a stale pick.
  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null);
  const approvalKey = nodeApproval ? approvalRowKey(nodeApproval) : null;
  useEffect(() => {
    setSelectedOptionKey(
      approvalMode === "select" ? approvalOptions[0]?.key ?? null : null,
    );
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
        const idx = Math.max(0, approvalOptions.findIndex((o) => o.key === cur));
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

  const approvalUi: ApprovalUiState | null = nodeApproval && !isHumanRequest
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
    const key = e.name;

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
        setActiveTab((prev) => {
          const idx = ALL_TABS.indexOf(prev);
          return ALL_TABS[Math.max(0, idx - 1)] ?? prev;
        });
      } else if (key === "right") {
        setActiveTab((prev) => {
          const idx = ALL_TABS.indexOf(prev);
          return ALL_TABS[Math.min(ALL_TABS.length - 1, idx + 1)] ?? prev;
        });
      }
      return;
    }

    if (focusPane === "tree") {
      if (key === "j" || key === "down") {
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
      } else if (key === "k" || key === "up") {
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (key === "space") {
        const item = flat[safeIdx];
        if (item?.hasChildren) {
          // Collapse state is keyed by the unique row `key` (matches flattenTree),
          // so two attempts of the same logical node fold independently.
          const key = runNodeKey(item.node);
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
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
        <text fg="#ff5f5f">{`  Error: ${error.message}`}</text>
      </box>
    );
  }

  const treePanelWidth = Math.floor(width * 0.38);

  if (compact) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <box width="100%" height="50%">
          <TreePanel flat={flat} focusIdx={safeIdx} panelWidth={Math.floor(width * 0.5)} />
        </box>
        <box width="100%" flexGrow={1}>
          <NodeInspector
            runId={runId}
            node={focusedNode}
            approval={approvalUi}
            humanRequest={humanRequestUi}
            activeTab={activeTab}
          />
        </box>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="row">
      <box width="38%" height="100%" border={["right"]} borderColor="#333333">
        <TreePanel flat={flat} focusIdx={safeIdx} panelWidth={treePanelWidth} />
      </box>
      <box width="62%" height="100%">
        <NodeInspector
          runId={runId}
          node={focusedNode}
          approval={approvalUi}
          humanRequest={humanRequestUi}
          activeTab={activeTab}
        />
      </box>
    </box>
  );
}
