import { WorkflowGraph } from "../askme/WorkflowGraph";
import { useCardUiStore } from "../cards/cardUiStore";
import { StatusPill } from "../cards/StatusPill";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { findNode, type RunNode } from "./Run";
import { NodeInspector } from "./NodeInspector";
import { RunTree } from "./RunTree";
import { runToFlow } from "./runToFlow";
import { useRunsStore } from "./runsStore";
import { selectRun } from "./selectRun";

/** First node still waiting on approval, i.e. the blocked node. The deploy gate
 *  is surfaced as an overall "waiting" status rather than a tree node, so fall
 *  back to a "deploy" label when no tree node carries the waiting status. */
function blockedNode(root: RunNode): RunNode | undefined {
  if (root.status === "waiting") {
    return root.children?.length ? undefined : root;
  }
  for (const child of root.children ?? []) {
    const hit = blockedNode(child);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * The run inspector surface (canvas): header with a Tree/Graph toggle, the node
 * tree on the left, and the selected node's detail on the right. Reads the run
 * live from the engine store so it advances while open; view and selection live
 * in the consolidated card-UI store. A waiting run raises an approval banner
 * above the tree (Approve/Deny → runsStore); a failed/cancelled run gets a
 * Resume button in the header cluster (→ runsStore.resume).
 */
export function RunInspector({
  runId,
  theme,
}: {
  runId: string;
  theme: "light" | "dark";
}) {
  const runs = useRunsStore((state) => state.runs);
  const approve = useRunsStore((state) => state.approve);
  const deny = useRunsStore((state) => state.deny);
  const resume = useRunsStore((state) => state.resume);
  const view = useCardUiStore((state) => state.inspectorView);
  const selectedId = useCardUiStore((state) => state.inspectorSelected);
  const setView = useCardUiStore((state) => state.setInspectorView);
  const selectNode = useCardUiStore((state) => state.selectNode);
  const say = useChatStore((state) => state.say);
  const notify = useNotificationsStore((state) => state.notify);
  const run = selectRun(runs, runId);

  if (!run) {
    return <div className="surface-empty">Run not found.</div>;
  }

  const selected = findNode(run.root, selectedId) ?? run.root;
  const flow = view === "graph" ? runToFlow(run) : null;
  const waiting = run.status === "waiting";
  const canResume = run.status === "failed";
  const blockedLabel = blockedNode(run.root)?.name ?? "deploy";
  const shortId = run.runId.slice(0, 8);

  function onApprove(): void {
    approve(runId);
    say(`Approved \`${blockedLabel}\` on run ${shortId}.`);
    notify({
      title: "Approval granted",
      detail: `${blockedLabel} · ${shortId}`,
      kind: "transient",
      command: "chat",
    });
  }

  function onDeny(): void {
    deny(runId);
    say(`Denied \`${blockedLabel}\` on run ${shortId}. The gate failed.`);
    notify({
      title: "Approval denied",
      detail: `${blockedLabel} · ${shortId}`,
      kind: "transient",
      command: "chat",
    });
  }

  function onResume(): void {
    resume(runId);
    say("Run resumed.");
    notify({
      title: "Run resumed",
      detail: shortId,
      kind: "transient",
      command: "chat",
    });
  }

  return (
    <section className="surface" data-testid="run-inspector">
      <header className="surface-head">
        <span className="surface-title">{run.title}</span>
        <StatusPill status={run.status} />
        {canResume ? (
          <button
            type="button"
            className="btn btn-brand run-resume"
            onClick={onResume}
          >
            ↻ Resume run
          </button>
        ) : null}
        <div className="seg">
          <button
            type="button"
            className={view === "tree" ? "is-on" : ""}
            onClick={() => setView("tree")}
          >
            Tree
          </button>
          <button
            type="button"
            className={view === "graph" ? "is-on" : ""}
            onClick={() => setView("graph")}
          >
            Graph
          </button>
        </div>
      </header>

      {view === "tree" ? (
        <>
          {waiting ? (
            <div className="runs-approval tone-waiting">
              <span>
                Waiting for approval: <b>{blockedLabel}</b>
              </span>
              <div className="runs-approval-actions">
                <button type="button" className="btn btn-brand" onClick={onApprove}>
                  Approve
                </button>
                <button type="button" className="btn btn-deny" onClick={onDeny}>
                  Deny
                </button>
              </div>
            </div>
          ) : null}
          <div className="inspector-body">
            <div className="tree-pane">
              <RunTree
                root={run.root}
                selectedId={selected.id}
                onSelect={selectNode}
              />
            </div>
            <NodeInspector run={run} node={selected} runId={runId} />
          </div>
        </>
      ) : (
        <div className="graph-pane">
          {flow ? (
            <WorkflowGraph nodes={flow.nodes} edges={flow.edges} theme={theme} />
          ) : null}
        </div>
      )}
    </section>
  );
}
