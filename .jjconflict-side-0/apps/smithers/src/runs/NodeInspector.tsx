import "./inspector.css";
import { openSurface } from "../app/navigation";
import { useCardUiStore, type InspectorTab } from "../cards/cardUiStore";
import { useChatStore } from "../chat/chatStore";
import type { Run, RunNode, ToolCall } from "./Run";
import {
  copyablePropValue,
  defaultTabFor,
  formatPropValue,
  isContainerNode,
  isPromptKey,
  nodeRoleDescription,
  pathToNode,
  propRows,
  sideEffectLabel,
  sideEffectTone,
  tabsFor,
} from "./nodeProps";
import { statusTone } from "./statusMeta";

/** Tool call rendered in the Tools section, with a keyword-derived side-effect
 *  badge (read→idle, write/mutate/shell/…→waiting, else→info). */
function ToolCallRow({ call }: { call: ToolCall }) {
  const fx = sideEffectTone(call.verb);
  const fxClass = fx === "idle" ? "is-read" : fx === "waiting" ? "is-write" : "is-other";
  return (
    <div className="toolcall">
      <span className={`toolcall-dot tone-${statusTone(call.status)}`} />
      <span className="toolcall-verb">⚒ {call.verb}</span>
      <span className="toolcall-target">{call.target}</span>
      <span className={`sidefx-badge ${fxClass}`}>{sideEffectLabel(fx)}</span>
    </div>
  );
}

/** One props-table row: mono key (accent for prompt keys), a formatted value
 *  with an [expand]/[collapse] toggle for long strings, a per-value copy button,
 *  and an "open prompt ↗" link when the key names a prompt. */
function PropRowView({ node, propKey, value }: { node: RunNode; propKey: string; value: ReturnType<typeof propRows>[number]["value"] }) {
  const path = `${node.id}/${propKey}`;
  const expanded = useCardUiStore((state) => state.propExpandedByPath[path] ?? false);
  const toggleExpanded = useCardUiStore((state) => state.togglePropExpanded);
  const fmt = formatPropValue(value);
  const prompt = isPromptKey(propKey);
  const clamp = fmt.expandable && !expanded;

  return (
    <div className="prop-row">
      <span className={prompt ? "prop-key is-prompt" : "prop-key"}>{propKey}</span>
      <span className={`prop-value prop-${fmt.tone}${clamp ? " is-clamped" : ""}`}>
        {fmt.text}
        {fmt.expandable ? (
          <button
            type="button"
            className="prop-expand"
            onClick={() => toggleExpanded(path)}
          >
            {expanded ? "[collapse]" : "[expand]"}
          </button>
        ) : null}
      </span>
      <span className="prop-actions">
        {prompt ? (
          <button
            type="button"
            className="prop-open-prompt"
            title="Open prompt"
            onClick={() => openSurface({ kind: "prompts" })}
          >
            ↗
          </button>
        ) : null}
        <button
          type="button"
          className="prop-copy"
          title="Copy value"
          onClick={() => void navigator.clipboard?.writeText(copyablePropValue(value))}
        >
          ⧉
        </button>
      </span>
    </div>
  );
}

/** The inspector's right pane: an ancestry breadcrumb, then tabbed detail for
 *  the selected node. Container nodes (workflow/sequence/loop/…) show only the
 *  Props tab plus a role description; task nodes show the full set. The active
 *  tab falls back to a sensible default whenever the stored tab is not valid for
 *  the current node, so selecting a node re-defaults without a useEffect. */
export function NodeInspector({
  run,
  node,
  runId,
}: {
  run: Run;
  node: RunNode;
  runId: string;
}) {
  const say = useChatStore((state) => state.say);
  const storedTab = useCardUiStore((state) => state.inspectorTab);
  const setTab = useCardUiStore((state) => state.setInspectorTab);
  const selectNode = useCardUiStore((state) => state.selectNode);

  // Derive everything in the render body (zero useEffect): the breadcrumb path,
  // the tabs this node exposes, and the effective tab (default-tab selection).
  const crumbs = pathToNode(run.root, node.id);
  const tabs = tabsFor(node);
  const tab: InspectorTab = tabs.includes(storedTab) ? storedTab : defaultTabFor(node);
  const container = isContainerNode(node);
  const rows = propRows(node, run);

  return (
    <div className="inspect-pane">
      <nav className="inspect-breadcrumb" aria-label="ancestry">
        {crumbs.map((crumb, i) => (
          <span key={crumb.id} style={{ display: "contents" }}>
            {i > 0 ? <span className="inspect-crumb-sep">›</span> : null}
            <button
              type="button"
              className="inspect-crumb"
              onClick={() => selectNode(crumb.id)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="inspect-tabs" role="tablist">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "inspect-tab is-on" : "inspect-tab"}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="inspect-body">
        {tab === "Output" ? (
          <>
            <div className="kv">
              <span>node</span>
              <b>{node.name}</b>
            </div>
            <div className="kv">
              <span>agent</span>
              <b>{node.agent ?? run.model}</b>
            </div>
            {node.output ? (
              <p className="node-output-text">{node.output}</p>
            ) : (
              <p className="node-empty">No output yet.</p>
            )}
            {node.status === "failed" || node.status === "running" ? (
              <button
                className="btn"
                type="button"
                onClick={() => say(`Retrying ${node.name}…`)}
              >
                ↻ Retry node
              </button>
            ) : null}
          </>
        ) : null}

        {tab === "Tools" ? (
          node.toolCalls?.length ? (
            <div className="toolcalls">
              {node.toolCalls.map((call) => (
                <ToolCallRow key={call.id} call={call} />
              ))}
            </div>
          ) : (
            <p className="node-empty">No tool calls in this node.</p>
          )
        ) : null}

        {tab === "Logs" ? (
          <>
            <pre className="node-stream">
              {`agent › working on ${node.name}\ntool  › ${
                node.toolCalls?.[0]?.verb ?? "Read"
              } ${node.toolCalls?.[0]?.target ?? node.name}`}
            </pre>
            <button
              className="btn"
              type="button"
              onClick={() => openSurface({ kind: "logs", runId })}
            >
              Open full logs →
            </button>
          </>
        ) : null}

        {tab === "Diff" ? (
          <>
            <p className="node-output-text">
              {node.toolCalls?.length
                ? `${node.toolCalls.length} file change${
                    node.toolCalls.length > 1 ? "s" : ""
                  } in this node.`
                : "No file changes in this node."}
            </p>
            <button
              className="btn"
              type="button"
              onClick={() =>
                openSurface({ kind: "diff", runId, diffId: "auth" })
              }
            >
              Review in canvas →
            </button>
          </>
        ) : null}

        {tab === "Props" ? (
          <>
            <div className="props">
              {rows.map((row) => (
                <PropRowView
                  key={row.key}
                  node={node}
                  propKey={row.key}
                  value={row.value}
                />
              ))}
            </div>
            {container ? (
              <p className="node-role-desc">{nodeRoleDescription(node)}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
