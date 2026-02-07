import { type Component, Show, For, Match, Switch, createMemo, createSignal } from "solid-js";
import { appState, setAppState, pushToast } from "../stores/app-store";
import { getRpc, refreshRuns, focusRun } from "../index";
import { formatTime, formatDuration } from "../lib/format";
import { cn } from "../lib/utils";
import type { InspectorTab } from "../stores/app-store";

const TABS: Array<{ key: InspectorTab; label: string }> = [
  { key: "graph", label: "Graph" },
  { key: "timeline", label: "Timeline" },
  { key: "logs", label: "Logs" },
  { key: "outputs", label: "Outputs" },
  { key: "attempts", label: "Attempts" },
];

export const Inspector: Component = () => {
  const detail = createMemo(() => {
    const id = appState.selectedRunId;
    return id ? appState.runDetails[id] : undefined;
  });

  const approvals = createMemo(() => {
    const d = detail();
    if (!d) return [];
    return d.nodes.filter((n) => n.state === "waiting-approval");
  });

  const handleApprove = async (nodeId: string, iteration: number) => {
    const runId = appState.selectedRunId;
    if (!runId) return;
    await getRpc().request.approveNode({ runId, nodeId, iteration });
    await refreshRuns();
    await focusRun(runId);
  };

  const handleDeny = async (nodeId: string, iteration: number) => {
    const runId = appState.selectedRunId;
    if (!runId) return;
    await getRpc().request.denyNode({ runId, nodeId, iteration });
    await refreshRuns();
    await focusRun(runId);
  };

  return (
    <div class="relative flex-shrink-0" style={{
      width: appState.inspectorOpen
        ? appState.inspectorExpanded ? "calc(100% - 56px)" : "380px"
        : "0px",
    }}>
    <aside
      id="sidebar"
      class={cn(
        "border-l border-border bg-panel overflow-hidden flex flex-col h-full w-full transition-all duration-300",
        !appState.inspectorOpen && "border-l-0 sidebar--closed"
      )}
      aria-label="Inspector"
      aria-hidden={!appState.inspectorOpen}
    >
      <div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span class="text-xs font-semibold uppercase tracking-wide text-muted">Inspector</span>
        <div class="flex gap-1">
          <button
            class="text-muted hover:text-foreground bg-transparent border border-border rounded px-1.5 py-0.5 text-xs cursor-pointer"
            onClick={() => setAppState("inspectorExpanded", (v) => !v)}
          >
            {appState.inspectorExpanded ? "⤡" : "⤢"}
          </button>
          <button
            class="text-muted hover:text-foreground bg-transparent border border-border rounded px-1.5 py-0.5 text-xs cursor-pointer"
            onClick={() => setAppState({ inspectorOpen: false, inspectorExpanded: false })}
          >
            ✕
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={detail()} fallback={
          <div class="text-muted text-xs uppercase tracking-wide text-center py-8">
            Select a run to inspect
          </div>
        }>
          {(d) => (
            <div class="flex flex-col">
              <div class="run-header__meta p-3 border-b border-border">
                <div class="font-semibold text-sm">{d().run.workflowName}</div>
                <div class="text-[10px] text-muted mt-1 flex flex-wrap gap-1">
                  <span class="mono font-mono">{d().run.runId}</span>
                  <span>• {d().run.status}</span>
                  <span>• {formatTime(d().run.startedAtMs)}</span>
                  <span>• {formatDuration(d().run.startedAtMs, d().run.finishedAtMs ?? null)}</span>
                </div>
                <div class="flex gap-1.5 mt-2">
                  <Show when={d().run.status === "running" || d().run.status === "waiting-approval"}>
                    <button
                      class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"
                      onClick={async () => {
                        if (!appState.selectedRunId) return;
                        await getRpc().request.cancelRun({ runId: appState.selectedRunId });
                        await refreshRuns();
                        await focusRun(appState.selectedRunId);
                        pushToast("info", "Run cancelled");
                      }}
                    >
                      Cancel
                    </button>
                  </Show>
                  <Show when={d().run.status === "failed" || d().run.status === "cancelled"}>
                    <button
                      class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"
                      onClick={async () => {
                        if (!appState.selectedRunId) return;
                        await getRpc().request.resumeRun({ runId: appState.selectedRunId });
                        await refreshRuns();
                        await focusRun(appState.selectedRunId);
                        pushToast("info", "Run resumed");
                      }}
                    >
                      Resume
                    </button>
                  </Show>
                </div>
              </div>

              <Show when={approvals().length > 0}>
                <div class="p-3 border-b border-border bg-warning/5">
                  <For each={approvals()}>
                    {(a) => (
                      <div class="approval-card py-1.5">
                        <div class="approval-card__title text-xs font-semibold uppercase tracking-wide text-warning mb-2">
                          Approval Required
                        </div>
                        <div class="flex items-center justify-between">
                          <div>
                            <span class="font-mono text-xs">{a.nodeId}</span>
                            <span class="text-[10px] text-muted ml-1">(iter {a.iteration})</span>
                          </div>
                          <div class="flex gap-1">
                            <button
                              class="btn btn-primary px-2 py-0.5 rounded bg-accent text-white text-[10px] font-semibold uppercase cursor-pointer"
                              onClick={() => handleApprove(a.nodeId, a.iteration)}
                            >Approve</button>
                            <button
                              class="btn btn-danger px-2 py-0.5 rounded bg-danger text-white text-[10px] font-semibold uppercase cursor-pointer"
                              onClick={() => handleDeny(a.nodeId, a.iteration)}
                            >Deny</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div class="flex border-b border-border">
                <For each={TABS}>
                  {(tab) => (
                    <button
                      class={cn(
                        "run-tab px-3 py-2 text-[11px] uppercase tracking-wide font-medium cursor-pointer bg-transparent border-none transition-colors",
                        appState.activeTab === tab.key
                          ? "text-accent border-b-2 border-b-accent"
                          : "text-muted hover:text-foreground"
                      )}
                      data-tab={tab.key}
                      onClick={() => setAppState("activeTab", tab.key)}
                    >
                      {tab.label}
                    </button>
                  )}
                </For>
              </div>

              <div class="flex-1 p-3 overflow-y-auto">
                <Switch>
                  <Match when={appState.activeTab === "graph"}>
                    <GraphTab runId={appState.selectedRunId!} />
                  </Match>
                  <Match when={appState.activeTab === "timeline"}>
                    <TimelineTab runId={appState.selectedRunId!} />
                  </Match>
                  <Match when={appState.activeTab === "logs"}>
                    <LogsTab runId={appState.selectedRunId!} />
                  </Match>
                  <Match when={appState.activeTab === "outputs"}>
                    <OutputsTab runId={appState.selectedRunId!} />
                  </Match>
                  <Match when={appState.activeTab === "attempts"}>
                    <AttemptsTab runId={appState.selectedRunId!} />
                  </Match>
                </Switch>
              </div>
            </div>
          )}
        </Show>
      </div>

    </aside>
    <Show when={!appState.inspectorOpen}>
      <div id="sidebar-collapsed" class="absolute right-0 top-1/2 -translate-y-1/2 z-10">
        <button
          id="sidebar-open"
          class="bg-panel border border-border rounded-l px-1 py-2 text-xs text-muted hover:text-foreground cursor-pointer"
          onClick={() => setAppState("inspectorOpen", true)}
        >
          ◀
        </button>
      </div>
    </Show>
    </div>
  );
};

function GraphTab(props: { runId: string }) {
  const frame = createMemo(() => appState.frames[props.runId]);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);

  const nodeDetail = createMemo(() => {
    const id = selectedNode();
    if (!id) return null;
    const f = frame();
    if (!f) return null;
    const node = f.graph.nodes.find((n) => n.id === id);
    return node ?? null;
  });

  const nodeOutput = createMemo(() => {
    const id = selectedNode();
    if (!id) return undefined;
    const outputData = appState.outputs[props.runId];
    if (!outputData) return undefined;
    for (const table of outputData.tables) {
      const row = table.rows.find((r: any) => r.nodeId === id || r.node_id === id);
      if (row) return row;
    }
    return undefined;
  });

  const zoom = () => appState.graphZoom;
  const transformStyle = () => `scale(${zoom()})`;

  return (
    <div>
      <div class="flex gap-1 mb-2">
        <button
          class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
          data-graph-action="zoom-in"
          onClick={() => setAppState("graphZoom", (z) => z * 1.2)}
        >
          +
        </button>
        <button
          class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
          data-graph-action="zoom-out"
          onClick={() => setAppState("graphZoom", (z) => z / 1.2)}
        >
          −
        </button>
        <button
          class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
          data-graph-action="fit"
          onClick={() => setAppState("graphZoom", 1)}
        >
          Fit
        </button>
      </div>

      <Show when={frame()} fallback={<div class="text-muted text-xs uppercase">No frame data yet.</div>}>
        {(f) => {
          const nodes = () => f().graph.nodes;
          const edges = () => f().graph.edges;

          return (
            <div class="graph-canvas overflow-auto" style={{ transform: transformStyle() }}>
              <svg
                width={Math.max(600, nodes().length * 180)}
                height={Math.max(400, nodes().length * 90)}
                class="block"
              >
                <For each={edges()}>
                  {(edge) => {
                    const fromIdx = () => nodes().findIndex((n) => n.id === edge.from);
                    const toIdx = () => nodes().findIndex((n) => n.id === edge.to);
                    const fromNode = () => nodes()[fromIdx()];
                    const toNode = () => nodes()[toIdx()];
                    const fromDepth = () => fromNode()?.kind === "Workflow" ? 0 : fromNode()?.kind === "Task" ? 2 : 1;
                    const toDepth = () => toNode()?.kind === "Workflow" ? 0 : toNode()?.kind === "Task" ? 2 : 1;
                    return (
                      <Show when={fromNode() && toNode()}>
                        <line
                          x1={fromDepth() * 180 + 180}
                          y1={fromIdx() * 90 + 64}
                          x2={toDepth() * 180 + 40}
                          y2={toIdx() * 90 + 64}
                          stroke="#1E2736"
                          stroke-width="2"
                        />
                      </Show>
                    );
                  }}
                </For>
                <For each={nodes()}>
                  {(node, idx) => {
                    const depth = () => node.kind === "Workflow" ? 0 : node.kind === "Task" ? 2 : 1;
                    const x = () => depth() * 180 + 40;
                    const y = () => idx() * 90 + 40;
                    const color = () => {
                      switch (node.state) {
                        case "in-progress": return { bg: "#0D1530", stroke: "#4C7DFF" };
                        case "finished": return { bg: "#0A1F1A", stroke: "#3DDC97" };
                        case "failed": return { bg: "#1E0A12", stroke: "#FF3B5C" };
                        case "waiting-approval": return { bg: "#1A1508", stroke: "#F2A43A" };
                        default: return { bg: "#10141A", stroke: "#2C3A4E" };
                      }
                    };
                    return (
                      <g
                        data-node-id={node.id}
                        class="cursor-pointer"
                        onClick={() => setSelectedNode(node.id)}
                      >
                        <rect x={x()} y={y()} rx="10" ry="10" width="140" height="48" fill={color().bg} stroke={color().stroke} />
                        <text x={x() + 12} y={y() + 28} fill="#e9eaf0" font-size="12">{node.label}</text>
                      </g>
                    );
                  }}
                </For>
              </svg>
            </div>
          );
        }}
      </Show>

      <Show when={nodeDetail()}>
        {(nd) => (
          <div class="node-drawer mt-3 border-t border-border pt-3">
            <div class="node-drawer__title text-sm font-semibold mb-2">{nd().label}</div>
            <div class="node-drawer__section mb-2">
              <div class="node-drawer__label text-[10px] text-muted uppercase tracking-wide mb-1">State</div>
              <div class="text-xs">{nd().state}</div>
            </div>
            <Show when={nodeOutput() !== undefined}>
              <div class="node-drawer__section mb-2">
                <div class="node-drawer__label text-[10px] text-muted uppercase tracking-wide mb-1">Output</div>
                <pre class="text-xs font-mono text-muted overflow-auto">{JSON.stringify(nodeOutput(), null, 2)}</pre>
              </div>
            </Show>
            <div class="node-drawer__actions flex gap-1 mt-2">
              <button
                class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
                data-copy="output"
                onClick={() => {
                  navigator.clipboard?.writeText(JSON.stringify(nodeOutput() ?? "", null, 2));
                  pushToast("info", "Output copied");
                }}
              >
                Copy Output
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function TimelineTab(props: { runId: string }) {
  const events = createMemo(() => appState.runEvents[props.runId] ?? []);
  const nonOutputEvents = createMemo(() => events().filter((e: any) => e.type !== "NodeOutput"));

  return (
    <div class="flex flex-col gap-1">
      <For each={nonOutputEvents()} fallback={<div class="text-muted text-xs uppercase">No events.</div>}>
        {(event) => (
          <div class="timeline-row flex gap-3 text-xs py-1">
            <span class="text-muted font-mono flex-shrink-0">{formatTime(event.timestampMs)}</span>
            <span class="text-foreground">{event.type}</span>
            <Show when={(event as any).nodeId}>
              <span class="text-muted font-mono">{(event as any).nodeId}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function LogsTab(props: { runId: string }) {
  const [search, setSearch] = createSignal("");
  const [showOutput, setShowOutput] = createSignal(true);
  const [activeFilters, setActiveFilters] = createSignal<Set<string>>(new Set(["run", "node", "approval", "revert"]));
  const events = createMemo(() => appState.runEvents[props.runId] ?? []);

  const outputText = createMemo(() => {
    const chunks: string[] = [];
    for (const e of events()) {
      if ((e as any).type === "NodeOutput") {
        chunks.push((e as any).text);
      }
    }
    return chunks.join("");
  });

  const filteredEvents = createMemo(() => {
    let evts = events();
    const q = search().toLowerCase();
    if (q) {
      evts = evts.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
    }
    const filters = activeFilters();
    evts = evts.filter((e) => {
      const type = (e.type ?? "").toLowerCase();
      if (type === "nodeoutput") return false; // shown separately
      if (type.startsWith("run") && !filters.has("run")) return false;
      if (type.startsWith("node") && !filters.has("node")) return false;
      if (type.startsWith("approval") && !filters.has("approval")) return false;
      if (type.startsWith("revert") && !filters.has("revert")) return false;
      return true;
    });
    return evts;
  });

  const toggleFilter = (f: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const exportLogs = () => {
    const data = filteredEvents().map((e) => JSON.stringify(e)).join("\n");
    const blob = new Blob([data], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.runId}-logs.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div class="flex gap-1 mb-2 items-center flex-wrap">
        <input
          id="logs-search"
          class="bg-background border border-border text-foreground text-xs rounded px-2 py-1 flex-1 min-w-[100px] focus:border-accent focus:outline-none"
          placeholder="Search logs…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <button
          class={cn(
            "logs-filter px-2 py-0.5 text-[10px] border border-border rounded cursor-pointer",
            showOutput() ? "bg-accent/20 text-accent" : "bg-panel-2 text-muted"
          )}
          onClick={() => setShowOutput((v) => !v)}
        >
          Output
        </button>
        {["Run", "Node", "Approval", "Revert"].map((f) => (
          <button
            class={cn(
              "logs-filter px-2 py-0.5 text-[10px] border border-border rounded cursor-pointer",
              activeFilters().has(f.toLowerCase()) ? "bg-accent/20 text-accent" : "bg-panel-2 text-muted"
            )}
            onClick={() => toggleFilter(f.toLowerCase())}
          >
            {f}
          </button>
        ))}
        <button
          id="logs-export"
          class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
          onClick={exportLogs}
        >
          Export
        </button>
        <button
          id="logs-copy"
          class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"
          onClick={() => {
            const data = showOutput() ? outputText() : filteredEvents().map((e) => JSON.stringify(e)).join("\n");
            navigator.clipboard?.writeText(data);
            pushToast("info", "Copied");
          }}
        >
          Copy
        </button>
      </div>
      <Show when={showOutput() && outputText()}>
        <div class="mb-3 border border-border rounded bg-background p-2">
          <div class="text-[10px] text-muted uppercase tracking-wide mb-1">Agent Output</div>
          <pre class="text-xs font-mono text-foreground overflow-auto whitespace-pre-wrap max-h-[400px]">{outputText()}</pre>
        </div>
      </Show>
      <pre class="logs text-xs font-mono text-muted overflow-auto whitespace-pre-wrap">
        {filteredEvents().map((e) => JSON.stringify(e)).join("\n")}
      </pre>
    </div>
  );
}

function OutputsTab(props: { runId: string }) {
  const outputs = createMemo(() => appState.outputs[props.runId]);
  return (
    <Show when={outputs()} fallback={<div class="text-muted text-xs uppercase">No outputs.</div>}>
      {(data) => (
        <For each={data().tables}>
          {(table) => (
            <div class="output-table mb-3">
              <div class="output-table__title text-xs font-semibold mb-1">{table.name} ({table.rows.length})</div>
              <pre class="text-xs font-mono text-muted overflow-auto">{JSON.stringify(table.rows, null, 2)}</pre>
            </div>
          )}
        </For>
      )}
    </Show>
  );
}

function AttemptsTab(props: { runId: string }) {
  const attempts = createMemo(() => appState.attempts[props.runId]);
  return (
    <Show when={attempts()} fallback={<div class="text-muted text-xs uppercase">No attempts.</div>}>
      {(data) => (
        <For each={data().attempts}>
          {(a) => (
            <div class="attempt-row flex justify-between items-start py-1.5 border-b border-border last:border-0">
              <div>
                <div class="font-mono text-xs">{a.nodeId}</div>
                <div class="text-[10px] text-muted">iter {a.iteration} - attempt {a.attempt}</div>
                <Show when={a.errorJson}>
                  <div class="text-[10px] text-danger mt-0.5">Error: {String(a.errorJson).slice(0, 140)}</div>
                </Show>
              </div>
              <div class="text-[10px] text-muted">{a.state}</div>
            </div>
          )}
        </For>
      )}
    </Show>
  );
}
