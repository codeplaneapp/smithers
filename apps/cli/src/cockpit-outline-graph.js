/**
 * Graph-primary outline: rebuild hierarchy from the last workflow frame
 * (DevTools snapshot) and join live node/attempt state.
 *
 * Fallback remains flat listNodes heuristics in cockpit-outline.js.
 */

import { getDevToolsSnapshotRoute } from "@smthrs/server/gatewayRoutes/getDevToolsSnapshot";

/**
 * Local identity helpers (avoid circular import with cockpit-outline.js).
 * @param {Record<string, unknown> | null | undefined} meta
 */
function identityFromMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return { backend: "", modelLine: "", identity: "" };
  }
  const modelRaw =
    (typeof meta.agentModel === "string" && meta.agentModel) || (typeof meta.model === "string" && meta.model) || "";
  const engine =
    (typeof meta.agentEngine === "string" && meta.agentEngine) ||
    (typeof meta.cliEngine === "string" && meta.cliEngine) ||
    "";
  const effort =
    (typeof meta.effort === "string" && meta.effort) ||
    (typeof meta.reasoningEffort === "string" && meta.reasoningEffort) ||
    (typeof meta.variant === "string" && meta.variant) ||
    "";
  let backend = "";
  if (/opencode/i.test(engine)) backend = "opencode";
  else if (/claude/i.test(engine)) backend = "claude-code";
  else if (/codex/i.test(engine)) backend = "codex";
  else if (/pi/i.test(engine)) backend = "pi";
  else if (engine)
    backend = String(engine)
      .replace(/Agent$/i, "")
      .toLowerCase();
  // Match cockpit-outline shortModelId: drop claude- when backend is claude-code
  let model = modelRaw;
  if ((backend === "claude-code" || backend === "claude") && /^claude[-_]/i.test(model)) {
    model = model.replace(/^claude[-_]/i, "");
  }
  const modelLine = [model, effort].filter(Boolean).join(" ");
  const identity = [backend, modelLine].filter(Boolean).join(" ");
  return { backend, modelLine, identity };
}

/**
 * @typedef {{
 *   key: string,
 *   kind: "task" | "group",
 *   groupType?: string,
 *   label: string,
 *   nodeId?: string | null,
 *   state: string,
 *   attempt: number,
 *   iteration?: number,
 *   backend?: string,
 *   modelLine?: string,
 *   identity?: string,
 *   expanded?: boolean,
 *   children: OutlineTreeNode[],
 * }} OutlineTreeNode
 */

/**
 * @param {import("@smthrs/protocol/devtools").DevToolsNode | null | undefined} node
 * @param {Record<string, Record<string, unknown>>} metaByNode
 * @param {string} path
 * @returns {OutlineTreeNode | null}
 */
export function mapDevToolsNodeToOutline(node, metaByNode = {}, path = "root") {
  if (!node || typeof node !== "object") return null;
  const type = String(node.type ?? "unknown");
  const childrenIn = Array.isArray(node.children) ? node.children : [];

  // Container types that should appear as expandable groups when they have structure.
  const groupTypes = new Set([
    "parallel",
    "sequence",
    "loop",
    "merge-queue",
    "branch",
    "worktree",
    "saga",
    "try-catch",
    "subflow",
  ]);

  if (node.task) {
    const nodeId =
      (node.task && typeof node.task.nodeId === "string" && node.task.nodeId) ||
      (typeof node.props?.id === "string" && node.props.id) ||
      (typeof node.props?.nodeId === "string" && node.props.nodeId) ||
      "";
    if (!nodeId) return null;
    const meta = metaByNode[nodeId] ?? {};
    const id = identityFromMeta(meta);
    const state = (node.task && typeof node.task.state === "string" && node.task.state) || "pending";
    const attempt = (node.task && typeof node.task.attempt === "number" && node.task.attempt) || 0;
    const label =
      (typeof node.task?.label === "string" && node.task.label) ||
      (typeof meta.label === "string" && meta.label) ||
      (typeof node.name === "string" && node.name !== "task" ? node.name : nodeId);
    return {
      key: nodeId,
      kind: "task",
      label,
      nodeId,
      state,
      attempt,
      iteration: typeof node.task?.iteration === "number" ? node.task.iteration : 0,
      backend: id.backend,
      modelLine: id.modelLine,
      identity: id.identity,
      children: [],
    };
  }

  // Workflow root: promote children to top-level list (no extra "workflow" chrome).
  if (type === "workflow" || type === "unknown") {
    const kids = childrenIn.map((c, i) => mapDevToolsNodeToOutline(c, metaByNode, `${path}/${i}`)).filter(Boolean);
    if (kids.length === 1) return kids[0];
    if (kids.length === 0) return null;
    return {
      key: `group:${node.id ?? path}`,
      kind: "group",
      groupType: type === "workflow" ? "sequence" : "group",
      label: type === "workflow" ? String(node.name || "workflow") : "group",
      state: aggregateChildState(kids),
      attempt: 0,
      expanded: true,
      children: kids,
    };
  }

  if (groupTypes.has(type)) {
    const kids = childrenIn
      .map((c, i) => mapDevToolsNodeToOutline(c, metaByNode, `${path}/${type}/${i}`))
      .filter(Boolean);
    // Flatten empty or single-child sequences to reduce chrome noise.
    if (type === "sequence") {
      if (kids.length === 0) return null;
      if (kids.length === 1) return kids[0];
    }
    const label =
      type === "parallel" ? "parallel" : type === "loop" ? "loop" : type === "merge-queue" ? "merge-queue" : type;
    const key = `group:${type}:${node.id ?? path}`;
    return {
      key,
      kind: "group",
      groupType: type,
      label,
      state: aggregateChildState(kids),
      attempt: 0,
      expanded: true,
      children: kids,
    };
  }

  // Unknown structural node: still try children.
  const kids = childrenIn.map((c, i) => mapDevToolsNodeToOutline(c, metaByNode, `${path}/x/${i}`)).filter(Boolean);
  if (kids.length === 1) return kids[0];
  if (kids.length === 0) return null;
  return {
    key: `group:${node.id ?? path}:misc`,
    kind: "group",
    groupType: type,
    label: String(node.name || type),
    state: aggregateChildState(kids),
    attempt: 0,
    expanded: true,
    children: kids,
  };
}

/**
 * @param {OutlineTreeNode[]} kids
 */
function aggregateChildState(kids) {
  if (
    kids.some((k) =>
      ["in-progress", "running", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(
        k.state,
      ),
    )
  )
    return "in-progress";
  if (kids.some((k) => k.state === "failed")) return "failed";
  if (kids.length > 0 && kids.every((k) => k.state === "finished" || k.state === "skipped")) return "finished";
  if (kids.some((k) => k.state === "pending")) return "pending";
  return kids[0]?.state ?? "pending";
}

/**
 * Apply expandOverrides to a tree (mutates expanded flags via new nodes).
 * @param {OutlineTreeNode | null} node
 * @param {Record<string, boolean>} overrides
 * @returns {OutlineTreeNode | null}
 */
export function applyExpandOverrides(node, overrides = {}) {
  if (!node) return null;
  if (node.kind === "task") return { ...node, children: [] };
  const bareKey = node.key.startsWith("phase:") ? node.key.slice("phase:".length) : node.key;
  let expanded = node.expanded !== false;
  if (Object.prototype.hasOwnProperty.call(overrides, node.key)) {
    expanded = overrides[node.key] === true;
  } else if (Object.prototype.hasOwnProperty.call(overrides, bareKey)) {
    expanded = overrides[bareKey] === true;
  }
  const children = (node.children ?? []).map((c) => applyExpandOverrides(c, overrides)).filter(Boolean);
  return { ...node, expanded, children };
}

/**
 * Flatten tree into paint/select order.
 * @param {OutlineTreeNode[]} roots
 * @param {Record<string, boolean>} [overrides]
 * @returns {{
 *   selectables: Array<{ key: string, phaseId: string, nodeId: string | null, label: string, state: string, attempt: number, kind: "agent" | "phase", identity?: string, steerable?: boolean }>,
 *   rows: Array<{ key: string, depth: number, isLast: boolean[], node: OutlineTreeNode }>,
 * }}
 */
export function flattenOutlineTree(roots, overrides = {}) {
  /** @type {ReturnType<typeof flattenOutlineTree>["selectables"]} */
  const selectables = [];
  /** @type {ReturnType<typeof flattenOutlineTree>["rows"]} */
  const rows = [];

  /**
   * @param {OutlineTreeNode[]} nodes
   * @param {boolean[]} isLastStack
   */
  const walk = (nodes, isLastStack) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isLast = i === nodes.length - 1;
      const stack = [...isLastStack, isLast];
      rows.push({ key: node.key, depth: isLastStack.length, isLast: stack, node });

      if (node.kind === "task") {
        selectables.push({
          key: node.key,
          phaseId: node.key,
          nodeId: node.nodeId ?? node.key,
          label: node.label,
          state: node.state,
          attempt: node.attempt,
          kind: "agent",
          identity: node.identity,
        });
      } else {
        selectables.push({
          key: node.key,
          phaseId: node.key,
          nodeId: null,
          label: node.label,
          state: node.state,
          attempt: 0,
          kind: "phase",
        });
        // Prefer expanded flag already applied via applyExpandOverrides.
        if (node.expanded !== false && node.children?.length) {
          walk(node.children, stack);
        }
      }
    }
  };

  const applied = roots.map((r) => applyExpandOverrides(r, overrides)).filter(Boolean);
  walk(applied, []);
  return { selectables, rows };
}

/**
 * Load hierarchical outline from last frame; null if no frame / parse fail.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {Record<string, Record<string, unknown>>} [metaByNode]
 * @returns {Promise<{ roots: OutlineTreeNode[], frameNo: number, source: "graph" } | null>}
 */
export async function loadOutlineTreeFromAdapter(adapter, runId, metaByNode = {}) {
  if (!adapter || !runId) return null;
  try {
    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId });
    if (!snapshot?.root) return null;
    // States already attached by getDevToolsSnapshotRoute; re-join meta for identity.
    const roots = [];
    const mapped = mapDevToolsNodeToOutline(snapshot.root, metaByNode, "root");
    if (!mapped) return null;
    // Promote workflow/sequence root children as top-level roots for a cleaner outline.
    if (
      mapped.kind === "group" &&
      (mapped.groupType === "sequence" || mapped.groupType === "workflow") &&
      mapped.children.length > 0
    ) {
      roots.push(...mapped.children);
    } else {
      roots.push(mapped);
    }
    if (roots.length === 0) return null;
    return { roots, frameNo: snapshot.frameNo ?? 0, source: "graph" };
  } catch {
    return null;
  }
}

/**
 * Convert legacy flat phases into tree roots (fallback path).
 * @param {Array<{ id: string, kind: string, title: string, agents: any[], expanded?: boolean }>} phases
 * @returns {OutlineTreeNode[]}
 */
export function outlinePhasesToTree(phases) {
  /** @type {OutlineTreeNode[]} */
  const roots = [];
  for (const p of phases ?? []) {
    if (p.kind === "single") {
      const a = p.agents?.[0];
      if (!a) continue;
      const loopBit = typeof p.loopLabel === "string" && p.loopLabel ? ` · ${p.loopLabel}` : "";
      roots.push({
        key: a.nodeId,
        kind: "task",
        label: `${a.displayName || a.nodeId}${loopBit}`,
        nodeId: a.nodeId,
        state: a.state ?? "pending",
        attempt: a.attempt ?? 0,
        iteration: a.iteration ?? 0,
        backend: a.backend,
        modelLine: a.modelLine,
        identity: a.identity,
        children: [],
      });
    } else {
      const children = (p.agents ?? []).map((a) => ({
        key: a.nodeId,
        kind: /** @type {"task"} */ ("task"),
        label: a.displayName || a.nodeId,
        nodeId: a.nodeId,
        state: a.state ?? "pending",
        attempt: a.attempt ?? 0,
        iteration: a.iteration ?? 0,
        backend: a.backend,
        modelLine: a.modelLine,
        identity: a.identity,
        children: [],
      }));
      const loopBit = typeof p.loopLabel === "string" && p.loopLabel ? ` · ${p.loopLabel}` : "";
      roots.push({
        key: `phase:${p.id}`,
        kind: "group",
        groupType: "parallel",
        label: `${p.title || "parallel"}${loopBit}`,
        state: children.some((c) => c.state === "in-progress")
          ? "in-progress"
          : children.every((c) => c.state === "finished")
            ? "finished"
            : "pending",
        attempt: 0,
        expanded: p.expanded !== false,
        children,
      });
    }
  }
  return roots;
}
