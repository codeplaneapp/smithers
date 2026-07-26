/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import {
  findTrellisNodeByPhase,
  trellisMetaOf,
  trellisNodeOutputRevision,
  trellisRunTruthOf,
  type TrellisMeta,
  type TrellisRunEvent,
} from "./trellis-state";

const WORKFLOW_KEY = "trellis";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type RunNode = {
  key?: string;
  id: string;
  name: string;
  cardLabel?: string;
  kind: string;
  status: string;
  iteration?: number;
  meta?: string;
  children?: RunNode[];
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rowOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.row) ? value.row : value;
}
function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function metaOf(node: RunNode): TrellisMeta | undefined {
  return trellisMetaOf(node);
}
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : "no run";
}
function statusTone(status: string | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (["finished", "ok", "complete", "passed"].includes(value)) return "ok";
  if (["failed", "cancelled", "blocked", "runtime_failed", "fuel_exhausted"].includes(value)) return "bad";
  if (["running", "continued", "queued", "pending", "waiting", "unknown"].includes(value)) return "warn";
  return "info";
}

const css = `
:root{--bg:#090b0d;--panel:#101419;--card:#151b21;--line:#27313a;--text:#edf3f7;--muted:#8d9ba7;--brand:#85d6a7;--brand2:#45a77a;--ok:#74d99f;--warn:#f1c46d;--bad:#ef7d7d;color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.capabilities{flex-wrap:wrap}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:13px;line-height:1.45}button,input,select,textarea{font:inherit}.shell{height:100vh;display:flex;flex-direction:column;overflow:hidden}.top{display:flex;gap:16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line);background:#0c1014}.brand{display:flex;align-items:center;gap:9px;min-width:220px}.mark{width:24px;height:24px;border:1px solid var(--brand2);border-radius:7px;display:grid;place-items:center;color:var(--brand);font-weight:800}.brand h1{font-size:14px;margin:0}.tag,.badge{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);font-size:11px}.badge.ok{color:var(--ok);border-color:#315f45}.badge.warn{color:var(--warn);border-color:#66552d}.badge.bad{color:var(--bad);border-color:#693838}.controls{display:flex;gap:8px;align-items:center;flex:1}.input,.select{background:var(--panel);border:1px solid var(--line);border-radius:7px;color:var(--text);padding:7px 9px}.prompt{flex:1;min-width:200px}.select{max-width:120px}.number{width:58px}.button{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);padding:7px 11px;cursor:pointer}.button:hover{background:var(--card)}.button.primary{background:var(--brand2);border-color:var(--brand2);color:#04120b;font-weight:700}.button.danger{color:var(--bad)}.button:disabled{opacity:.45;cursor:not-allowed}.capabilities{display:flex;gap:8px;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--panel)}.cap{font-size:11px;color:var(--muted)}.cap strong{color:var(--text)}.layout{display:grid;grid-template-columns:minmax(260px,1fr) minmax(420px,1.55fr) minmax(300px,1fr);flex:1;min-height:0}.pane{min-width:0;overflow:auto;border-right:1px solid var(--line)}.pane:last-child{border-right:0}.pane-head{position:sticky;top:0;z-index:2;background:rgba(16,20,25,.96);border-bottom:1px solid var(--line);padding:10px 14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-size:10px}.outcome{padding:14px}.hero{border:1px solid var(--line);border-radius:10px;background:linear-gradient(135deg,#142119,#13191f);padding:16px;margin-bottom:12px}.hero h2{font-size:18px;margin:6px 0}.hero p{margin:0;color:#c4cfd6}.facts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.fact{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:3px 6px}.empty{padding:28px 18px;color:var(--muted);text-align:center}.section{border:1px solid var(--line);border-radius:9px;background:var(--card);margin-bottom:12px;overflow:hidden}.section-title{padding:8px 10px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.proof-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;padding:9px 10px;border-bottom:1px solid var(--line)}.proof-row:last-child{border-bottom:0}.proof-copy{min-width:0}.proof-copy strong{display:block;font-size:12px}.proof-copy small{display:block;color:var(--muted);overflow-wrap:anywhere}.program-row,.run-row{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;background:transparent;border:0;border-bottom:1px solid var(--line);color:var(--text);text-align:left;cursor:pointer}.program-row:last-child,.run-row:last-child{border-bottom:0}.program-row:hover,.run-row:hover{background:#1a2229}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.tree{padding:10px}.tree-node{margin-left:14px;border-left:1px solid #28343d;padding-left:8px}.tree-node.root{margin-left:0;border-left:0;padding-left:0}.node-button{width:100%;display:grid;grid-template-columns:10px 1fr auto;gap:8px;align-items:center;border:0;border-radius:7px;background:transparent;color:var(--text);padding:7px 8px;text-align:left;cursor:pointer}.node-button:hover,.node-button.selected{background:var(--card)}.dot{width:7px;height:7px;border-radius:50%;background:#56636d}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.node-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node-meta{font-size:10px;color:var(--muted)}.inspector{padding:12px}.pre{white-space:pre-wrap;word-break:break-word;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:10px;background:#0b0f12;color:#c8d4dc;max-height:46vh;overflow:auto}.events{max-height:32vh;overflow:auto}.event{display:grid;grid-template-columns:44px 1fr;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line);font-size:11px}.event-seq{color:var(--muted)}.error{color:var(--bad);padding:8px 12px}.launch-empty{max-width:620px;margin:10vh auto;padding:22px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.launch-empty h2{margin:0 0 7px}.launch-empty textarea{width:100%;min-height:110px;margin:14px 0}.run-select{max-width:160px}.launcher-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}@media(max-width:1050px){.layout{grid-template-columns:1fr 1fr}.pane.inspect-pane{display:none}.top{align-items:flex-start}.controls{flex-wrap:wrap}.brand{min-width:160px}}`;

function useLiveNodeOutput({
  runId,
  node,
  events,
}: {
  runId: string | undefined;
  node: RunNode | undefined;
  events: readonly TrellisRunEvent[];
}) {
  const query = useGatewayNodeOutput({
    runId,
    nodeId: node?.id,
    iteration: node?.iteration ?? 0,
  });
  const key = runId && node ? `${runId}:${node.id}:${node.iteration ?? 0}` : undefined;
  const revision = useMemo(
    () => trellisNodeOutputRevision(node, events),
    [node?.id, node?.iteration, node?.status, events],
  );
  const previous = useRef<{ key: string | undefined; revision: string } | undefined>(undefined);

  useEffect(() => {
    const prior = previous.current;
    previous.current = { key, revision };
    // useGatewayNodeOutput owns the initial/key-change fetch. Refetch only when
    // a live source says that same node may now have a different output.
    if (!key || prior?.key !== key || prior.revision === revision) return;
    void query.refetch();
  }, [key, revision, query.refetch]);

  return query;
}

function TreeNode({
  node,
  selected,
  onSelect,
  root = false,
}: {
  node: RunNode;
  selected?: string;
  onSelect: (node: RunNode) => void;
  root?: boolean;
}) {
  const meta = metaOf(node);
  return (
    <div className={`tree-node${root ? " root" : ""}`}>
      <button
        className={`node-button${selected === (node.key ?? node.id) ? " selected" : ""}`}
        onClick={() => onSelect(node)}
      >
        <span className={`dot ${statusTone(node.status)}`} />
        <span className="node-label">{node.cardLabel ?? node.name ?? node.id}</span>
        <span className="node-meta">
          {meta?.role ? `${meta.role} · ` : ""}
          {meta?.phase ?? node.kind}
          {meta?.criticalExecutionGrantHash ? " · critical grant" : ""}
        </span>
      </button>
      {(node.children ?? []).map((child) => (
        <TreeNode
          key={child.key ?? `${child.id}:${child.iteration ?? 0}`}
          node={child}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ValidationProgramRow({
  runId,
  node,
  events,
  onSelect,
}: {
  runId: string;
  node: RunNode;
  events: readonly TrellisRunEvent[];
  onSelect: (node: RunNode) => void;
}) {
  const query = useLiveNodeOutput({ runId, node, events });
  const row = rowOf(query.data);
  const validationStatus = textOf(row?.status, node.status);
  const meta = metaOf(node);
  return (
    <button className="program-row" onClick={() => onSelect(node)}>
      <span className="proof-copy">
        <strong>{node.cardLabel ?? node.name}</strong>
        <small>
          generation {meta?.generation ?? "?"}
          {validationStatus === "rejected" ? " · never executed" : ""}
        </small>
      </span>
      <span
        className={`badge ${validationStatus === "accepted" ? "ok" : validationStatus === "rejected" ? "bad" : statusTone(validationStatus)}`}
      >
        {validationStatus}
      </span>
    </button>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedNode, setSelectedNode] = useState<RunNode | undefined>();
  const [prompt, setPrompt] = useState("");
  const [role, setRole] = useState<"sol" | "fable">("sol");
  const [work, setWork] = useState("synthesize");
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [maxAuthorGenerations, setMaxAuthorGenerations] = useState(4);
  const [maxAuthorDepth, setMaxAuthorDepth] = useState(4);
  const [maxTotalAuthorTurns, setMaxTotalAuthorTurns] = useState(32);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = useGatewayActions();
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const runs = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runs[0]?.runId;
  const activeRun = runs.find((run) => run.runId === activeRunId);
  const tree = useGatewayRunTree(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { maxEvents: 100 });
  const finalNode = useMemo(() => findTrellisNodeByPhase(tree.nodes as RunNode[], "final"), [tree.nodes]);
  const liveSelectedNode = useMemo(() => {
    if (!selectedNode) return undefined;
    const selectedKey = selectedNode.key ?? selectedNode.id;
    return (tree.nodes.find((node) => (node.key ?? node.id) === selectedKey) as RunNode | undefined) ?? selectedNode;
  }, [tree.nodes, selectedNode]);
  const finalQuery = useLiveNodeOutput({ runId: activeRunId, node: finalNode, events: stream.events });
  const selectedQuery = useLiveNodeOutput({ runId: activeRunId, node: liveSelectedNode, events: stream.events });
  const finalRow = rowOf(finalQuery.data);
  const finalOutcome = isRecord(finalRow?.outcome) ? finalRow.outcome : undefined;
  const finalProduct = isRecord(finalOutcome?.product) ? finalOutcome.product : undefined;
  const finalBlockage = isRecord(finalOutcome?.blockage) ? finalOutcome.blockage : undefined;
  const finalFailure = isRecord(finalOutcome?.runtimeFailure) ? finalOutcome.runtimeFailure : undefined;
  const acceptanceRows = recordArray(finalProduct?.acceptance);
  const evidenceRows = recordArray(finalProduct?.evidence);
  const artifactRows = recordArray(finalProduct?.artifacts);
  const validationNodes = useMemo(
    () => tree.nodes.filter((node) => metaOf(node as RunNode)?.phase === "validation") as RunNode[],
    [tree.nodes],
  );
  const activeCriticalPolicyHash = useMemo(() => {
    for (const node of tree.nodes as RunNode[]) {
      const hash = metaOf(node)?.criticalExecutionPolicyHash;
      if (hash) return hash;
    }
    return undefined;
  }, [tree.nodes]);
  const activeRunTruth = useMemo(() => trellisRunTruthOf(tree.nodes as RunNode[]), [tree.nodes]);

  async function launch() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: {
          prompt: prompt.trim(),
          role,
          work,
          maxConcurrency,
          maxAuthorGenerations,
          maxAuthorDepth,
          maxTotalAuthorTurns,
        },
        options: { maxConcurrency },
      });
      setSelectedRunId(result.runId);
      setSelectedNode(undefined);
      await runsQuery.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await runsQuery.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="trellis-ui">
      <style>{css}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="top">
        <div className="brand">
          <span className="mark">T</span>
          <h1>Smithers Trellis</h1>
          <span className="tag">experimental</span>
        </div>
        <div className="controls">
          <span className="launcher-label">Next launch</span>
          <input
            className="input prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Describe the outcome to build…"
            data-testid="trellis-prompt"
          />
          <select
            className="select"
            value={role}
            onChange={(event) => setRole(event.currentTarget.value as "sol" | "fable")}
            title="Next launch root author"
          >
            <option value="sol">Sol</option>
            <option value="fable">Fable</option>
          </select>
          <select
            className="select"
            value={work}
            onChange={(event) => setWork(event.currentTarget.value)}
            title="Next launch root work"
          >
            {["synthesize", "refine_goal", "plan", "research", "poc", "execute", "review", "preview"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input
            className="input number"
            type="number"
            min={1}
            max={16}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.currentTarget.value))}
            title="Next launch max concurrency"
          />
          <input
            className="input number"
            type="number"
            min={1}
            max={12}
            value={maxAuthorGenerations}
            onChange={(event) => setMaxAuthorGenerations(Number(event.currentTarget.value))}
            title="Next launch author generations"
          />
          <input
            className="input number"
            type="number"
            min={1}
            max={8}
            value={maxAuthorDepth}
            onChange={(event) => setMaxAuthorDepth(Number(event.currentTarget.value))}
            title="Next launch author depth"
          />
          <input
            className="input number"
            type="number"
            min={1}
            max={256}
            value={maxTotalAuthorTurns}
            onChange={(event) => setMaxTotalAuthorTurns(Number(event.currentTarget.value))}
            title="Next launch global author turns"
          />
          <button
            className="button primary"
            disabled={busy || !prompt.trim()}
            onClick={() => void launch()}
            data-testid="trellis-launch"
          >
            {busy ? "Launching…" : "Grow"}
          </button>
          {activeRun && ["running", "continued"].includes(activeRun.status ?? "") ? (
            <button className="button danger" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
          <select
            className="select run-select"
            value={activeRunId ?? ""}
            onChange={(event) => {
              setSelectedRunId(event.currentTarget.value || undefined);
              setSelectedNode(undefined);
            }}
          >
            <option value="">Recent runs</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {shortId(run.runId)} · {run.status ?? "unknown"}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="capabilities">
        <span className="cap">
          <strong>Questions</strong> unavailable in Phase A
        </span>
        <span className="cap">
          <strong>Next launch defaults</strong> concurrency {maxConcurrency} · {maxTotalAuthorTurns} turns ·{" "}
          {maxAuthorGenerations} generations · {maxAuthorDepth} depth
        </span>
        {activeRun ? (
          activeRunTruth ? (
            <span className="cap" data-testid="trellis-run-truth">
              <strong>Selected run truth</strong> concurrency {activeRunTruth.rootMaxConcurrency} · author fuel{" "}
              {activeRunTruth.rootAuthorTurnsTotal} total
              {activeRunTruth.rootAuthorTurnsRemaining === undefined
                ? ""
                : ` · root-local ${activeRunTruth.rootAuthorTurnsRemaining} / ${activeRunTruth.rootAuthorTurnsAllocated ?? activeRunTruth.rootAuthorTurnsTotal} turns remain`}
              {activeRunTruth.rootMaxAuthorGenerations === undefined
                ? ""
                : ` · ${activeRunTruth.rootMaxAuthorGenerations} generations`}
              {activeRunTruth.rootMaxAuthorDepth === undefined ? "" : ` · ${activeRunTruth.rootMaxAuthorDepth} depth`}
            </span>
          ) : (
            <span className="cap" data-testid="trellis-run-truth">
              <strong>Selected run truth</strong> not persisted by this run
            </span>
          )
        ) : null}
        <span className="cap">
          <strong>Budgets</strong> token/USD hierarchy not enforced yet
        </span>
        <span className="cap">
          <strong>Tool/filesystem authority</strong> adapter-dependent; prompt restrictions are advisory
        </span>
        <span className="cap">
          <strong>Critical Sol/Fable writes</strong> UI launches disabled; caller policy is admission-only, not measured
          diff enforcement{activeCriticalPolicyHash ? ` · active ${activeCriticalPolicyHash.slice(0, 8)}` : ""}
        </span>
        {activeRun ? (
          <span className={`badge ${statusTone(activeRun.status)}`}>
            {shortId(activeRun.runId)} · {activeRun.status}
          </span>
        ) : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {!activeRunId ? (
        <section className="launch-empty">
          <h2>Let the work grow. Keep it bounded.</h2>
          <p>
            Give Sol or Fable an outcome. It authors the smallest safe graph, delegates aggressively, and reassesses
            settled evidence until the goal is proven or fuel ends.
          </p>
          <textarea
            className="input"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="What should Trellis accomplish?"
          />
          <button className="button primary" disabled={busy || !prompt.trim()} onClick={() => void launch()}>
            Grow a Trellis
          </button>
        </section>
      ) : (
        <div className="layout">
          <section className="pane">
            <div className="pane-head">Outcome & authored programs</div>
            <div className="outcome">
              <div className="hero">
                <span className={`badge ${statusTone(String(finalRow?.status ?? activeRun?.status ?? ""))}`}>
                  {String(finalRow?.status ?? activeRun?.status ?? "running")}
                </span>
                <h2>{typeof finalRow?.summary === "string" ? finalRow.summary : "Trellis is growing…"}</h2>
                <p>
                  {finalRow
                    ? "The final canonical outcome is persisted and replayable."
                    : "The root author is still evaluating delegated evidence."}
                </p>
                {finalOutcome ? (
                  <div className="facts">
                    <span className="fact">{textOf(finalOutcome.role, "role?")}</span>
                    <span className="fact">{textOf(finalOutcome.work, "work?")}</span>
                    <span className="fact">{textOf(finalOutcome.outputContract, "contract?")}</span>
                    <span className="fact">generation {String(finalOutcome.generation ?? "?")}</span>
                  </div>
                ) : null}
              </div>
              {acceptanceRows.length ? (
                <div className="section">
                  <div className="section-title">Acceptance evidence</div>
                  {acceptanceRows.map((judgment, index) => (
                    <div className="proof-row" key={textOf(judgment.criterionId, String(index))}>
                      <span className={`badge ${statusTone(textOf(judgment.status))}`}>
                        {textOf(judgment.status, "unknown")}
                      </span>
                      <span className="proof-copy">
                        <strong>{textOf(judgment.criterionId, `criterion ${index + 1}`)}</strong>
                        <small>{textOf(judgment.explanation, "No explanation persisted.")}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {evidenceRows.length || artifactRows.length ? (
                <div className="section">
                  <div className="section-title">Proofs & artifacts</div>
                  {[...evidenceRows, ...artifactRows].map((proof, index) => (
                    <div className="proof-row" key={textOf(proof.id, String(index))}>
                      <span className="tag">{textOf(proof.kind, "proof")}</span>
                      <span className="proof-copy">
                        <strong>{textOf(proof.id, `proof ${index + 1}`)}</strong>
                        <small>{textOf(proof.summary, textOf(proof.locator, "No summary persisted."))}</small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {finalBlockage || finalFailure ? (
                <div className="section">
                  <div className="section-title">Why work stopped</div>
                  <div className="proof-row">
                    <span className="badge bad">{finalFailure ? textOf(finalFailure.code, "failure") : "blocked"}</span>
                    <span className="proof-copy">
                      <strong>
                        {textOf(finalFailure?.message, textOf(finalBlockage?.summary, "No summary persisted."))}
                      </strong>
                      <small>{textOf(finalBlockage?.requiredNextAction)}</small>
                    </span>
                  </div>
                </div>
              ) : null}
              <div className="section">
                <div className="section-title">Accepted / rejected programs</div>
                {validationNodes.length ? (
                  validationNodes.map((node) => (
                    <ValidationProgramRow
                      key={node.key ?? node.id}
                      runId={activeRunId}
                      node={node}
                      events={stream.events}
                      onSelect={setSelectedNode}
                    />
                  ))
                ) : (
                  <div className="empty">No authored program has reached validation yet.</div>
                )}
              </div>
              <div className="section">
                <div className="section-title">Recent runs</div>
                {runs.slice(0, 10).map((run) => (
                  <button
                    key={run.runId}
                    className="run-row"
                    onClick={() => {
                      setSelectedRunId(run.runId);
                      setSelectedNode(undefined);
                    }}
                  >
                    <span className="mono">{shortId(run.runId)}</span>
                    <span className={`badge ${statusTone(run.status)}`}>{run.status ?? "unknown"}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="pane">
            <div className="pane-head">Live execution tree · {tree.nodes.length} nodes</div>
            <div className="tree">
              {tree.root ? (
                <TreeNode
                  node={tree.root as RunNode}
                  root
                  selected={selectedNode?.key ?? selectedNode?.id}
                  onSelect={setSelectedNode}
                />
              ) : (
                <div className="empty">{tree.isLoading ? "Loading run tree…" : "Waiting for the first node…"}</div>
              )}
            </div>
          </section>
          <aside className="pane inspect-pane">
            <div className="pane-head">Inspector & timeline</div>
            <div className="inspector">
              <div className="section">
                <div className="section-title">
                  {liveSelectedNode ? (liveSelectedNode.cardLabel ?? liveSelectedNode.name) : "Select a node"}
                </div>
                {liveSelectedNode ? (
                  <pre className="pre">
                    {selectedQuery.loading
                      ? "Loading output…"
                      : pretty({
                          metadata: metaOf(liveSelectedNode),
                          output: selectedQuery.data ?? {
                            message: "No output persisted for this container or queued node.",
                          },
                        })}
                  </pre>
                ) : (
                  <div className="empty">Select any runtime or validation node to inspect its real Gateway output.</div>
                )}
              </div>
              <div className="section">
                <div className="section-title">Event timeline · {stream.events.length}</div>
                <div className="events">
                  {stream.events
                    .slice(-50)
                    .reverse()
                    .map((event) => (
                      <div className="event" key={event.seq}>
                        <span className="event-seq">#{event.seq}</span>
                        <span>
                          <strong>{event.event}</strong>
                          <br />
                          {isRecord(event.payload) && typeof event.payload.nodeId === "string"
                            ? event.payload.nodeId
                            : ""}
                        </span>
                      </div>
                    ))}
                  {!stream.events.length ? (
                    <div className="empty">{stream.loading ? "Loading events…" : "No events yet."}</div>
                  ) : null}
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

createGatewayReactRoot(<App />);
