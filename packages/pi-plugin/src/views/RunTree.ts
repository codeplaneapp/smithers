import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { DevToolsNode } from "@smithers-orchestrator/protocol";
import type { DevToolsStore } from "../runtime/DevToolsStore.js";

type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

type TreeRow = {
  node: DevToolsNode;
  depth: number;
};

function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

function bold(theme: Theme, value: string) {
  return theme.bold ? theme.bold(value) : value;
}

function stateOf(node: DevToolsNode) {
  const raw = node.props.state;
  return typeof raw === "string" ? raw : "unknown";
}

function normalizedState(node: DevToolsNode) {
  return stateOf(node).trim().toLowerCase().replace(/[_\s]/g, "-");
}

function stateIcon(node: DevToolsNode) {
  switch (normalizedState(node)) {
    case "running":
    case "in-progress":
      return ">";
    case "finished":
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
    case "done":
      return "v";
    case "failed":
    case "error":
      return "x";
    case "blocked":
    case "waitingapproval":
    case "waiting-approval":
    case "waiting-timer":
      return "!";
    case "cancelled":
    case "canceled":
      return "-";
    default:
      return "o";
  }
}

function stateColor(node: DevToolsNode) {
  switch (stateIcon(node)) {
    case ">":
      return "accent";
    case "v":
      return "success";
    case "x":
      return "error";
    case "!":
      return "warning";
    case "-":
      return "dim";
    default:
      return "muted";
  }
}

function nodeLabel(node: DevToolsNode) {
  return node.task?.label ?? node.task?.nodeId ?? node.name;
}

function propsSummary(node: DevToolsNode, maxLength = 80) {
  const parts: string[] = [];
  const id = node.props.id;
  const name = node.props.name;
  if (typeof id === "string" && id.length > 0) {
    parts.push(`id=${id}`);
  }
  if (typeof name === "string" && name.length > 0) {
    parts.push(`name=${name}`);
  }
  if (node.task?.agent) {
    parts.push(`agent=${node.task.agent}`);
  }
  if (typeof node.task?.iteration === "number" && node.task.iteration > 0) {
    parts.push(`iter=${node.task.iteration}`);
  }
  const summary = parts.join(" ");
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}...` : summary;
}

function findParent(root: DevToolsNode | undefined, childId: number): DevToolsNode | undefined {
  if (!root) {
    return undefined;
  }
  for (const child of root.children) {
    if (child.id === childId) {
      return root;
    }
    const found = findParent(child, childId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findNode(root: DevToolsNode | undefined, id: number): DevToolsNode | undefined {
  if (!root) {
    return undefined;
  }
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function failedDescendantCount(node: DevToolsNode) {
  let count = 0;
  for (const child of node.children) {
    if (stateIcon(child) === "x") {
      count += 1;
    }
    count += failedDescendantCount(child);
  }
  return count;
}

function collectRows(node: DevToolsNode, expandedIds: Set<number>, rows: TreeRow[]) {
  rows.push({ node, depth: node.depth });
  if (expandedIds.has(node.id)) {
    for (const child of node.children) {
      collectRows(child, expandedIds, rows);
    }
  }
}

function collectPathIds(root: DevToolsNode, target: (node: DevToolsNode) => boolean) {
  const ids = new Set<number>();
  const walk = (node: DevToolsNode, path: number[]) => {
    if (target(node)) {
      for (const id of path) {
        ids.add(id);
      }
      ids.add(node.id);
    }
    for (const child of node.children) {
      walk(child, [...path, node.id]);
    }
  };
  walk(root, []);
  return ids;
}

function searchText(node: DevToolsNode) {
  return [
    node.name,
    node.type,
    node.task?.nodeId,
    node.task?.label,
    node.task?.agent,
    propsSummary(node, 200),
  ].filter(Boolean).join(" ").toLowerCase().normalize("NFC");
}

export class RunTree {
  private readonly expandedIds = new Set<number>();
  private readonly userCollapsedIds = new Set<number>();
  private scrollOffset = 0;
  private searchQuery = "";
  private searchMode = false;
  private lastAutoSeq = -1;

  constructor(private readonly store: DevToolsStore) {}

  handleInput(data: string) {
    if (this.searchMode) {
      if (matchesKey(data, "escape")) {
        this.searchMode = false;
        this.searchQuery = "";
        return "handled";
      }
      if (matchesKey(data, "enter")) {
        this.searchMode = false;
        return "handled";
      }
      if (data === "\x7f" || matchesKey(data, "backspace")) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        return "handled";
      }
      if (data.length === 1 && data >= " ") {
        this.searchQuery += data;
        return "handled";
      }
      return "handled";
    }

    const rows = this.visibleRows();
    if (matchesKey(data, "/") || matchesKey(data, "f")) {
      this.searchMode = true;
      return "handled";
    }
    if (matchesKey(data, "j") || data === "\x1b[B") {
      this.moveSelection(1, rows);
      return "handled";
    }
    if (matchesKey(data, "k") || data === "\x1b[A") {
      this.moveSelection(-1, rows);
      return "handled";
    }
    if (data === "\x1b[D") {
      this.collapseSelected();
      return "handled";
    }
    if (data === "\x1b[C") {
      this.expandSelected(rows);
      return "handled";
    }
    if (matchesKey(data, "home") || matchesKey(data, "g")) {
      this.selectRow(rows[0]);
      return "handled";
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.selectRow(rows[rows.length - 1]);
      return "handled";
    }
    if (matchesKey(data, "enter")) {
      return "focusInspector";
    }
    return "unhandled";
  }

  render(width: number, height: number, theme: Theme) {
    const W = Math.max(28, width);
    const H = Math.max(3, height);
    this.rebuildAutoExpansion();
    const rows = this.visibleRows();
    this.ensureSelection(rows);
    this.ensureScroll(rows, H - 2);
    const query = this.searchQuery.trim().toLowerCase().normalize("NFC");
    const header = this.searchMode
      ? paint(theme, "accent", ` /${this.searchQuery}`)
      : paint(theme, "muted", ` tree ${rows.length} rows  / search`);
    const lines = [truncateToWidth(header, W)];
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + H - 2);
    for (const row of visible) {
      lines.push(this.renderRow(row, W, theme, query));
    }
    while (lines.length < H) {
      lines.push("");
    }
    return lines.slice(0, H);
  }

  visibleRows() {
    const root = this.store.tree;
    if (!root) {
      return [];
    }
    const rows: TreeRow[] = [];
    collectRows(root, this.expandedIds, rows);
    if (!this.searchQuery.trim()) {
      return rows;
    }
    const query = this.searchQuery.trim().toLowerCase().normalize("NFC");
    return rows.filter((row) => searchText(row.node).includes(query));
  }

  private renderRow(row: TreeRow, width: number, theme: Theme, query: string) {
    const node = row.node;
    const selected = this.store.selectedNodeId === node.id;
    const expanded = this.expandedIds.has(node.id);
    const chevron = node.children.length === 0 ? " " : expanded ? "v" : ">";
    const failedCount = failedDescendantCount(node);
    const failedBubble = failedCount > 0 && !expanded ? paint(theme, "error", ` !${failedCount}`) : "";
    const ghost = this.store.isGhostNode(node) ? paint(theme, "dim", " ghost") : "";
    const searchMatch = query && searchText(node).includes(query);
    const marker = selected ? paint(theme, "accent", ">") : " ";
    const label = searchMatch ? bold(theme, nodeLabel(node)) : nodeLabel(node);
    const summary = propsSummary(node);
    const dim = query && !searchMatch ? "dim" : "muted";
    const indent = " ".repeat(Math.min(20, row.depth * 2));
    const line =
      `${marker}${indent}${chevron} ${paint(theme, stateColor(node), stateIcon(node))} ` +
      `${paint(theme, selected ? "accent" : "muted", `<${node.type}>`)} ` +
      `${paint(theme, selected ? "accent" : "default", label)} ` +
      `${paint(theme, dim, summary)}${failedBubble}${ghost}`;
    return truncateToWidth(line, width);
  }

  private rebuildAutoExpansion() {
    const root = this.store.tree;
    if (!root || this.lastAutoSeq === this.store.seq) {
      return;
    }
    this.lastAutoSeq = this.store.seq;
    this.expandedIds.add(root.id);
    const running = collectPathIds(root, (node) => stateIcon(node) === ">");
    const failed = collectPathIds(root, (node) => stateIcon(node) === "x");
    for (const id of [...running, ...failed]) {
      if (!this.userCollapsedIds.has(id)) {
        this.expandedIds.add(id);
      }
    }
  }

  private ensureSelection(rows: TreeRow[]) {
    if (rows.length === 0) {
      return;
    }
    if (this.store.selectedNodeId === undefined || !rows.some((row) => row.node.id === this.store.selectedNodeId)) {
      this.store.selectNode(rows[0].node.id);
    }
  }

  private ensureScroll(rows: TreeRow[], visibleCount: number) {
    const selectedIndex = rows.findIndex((row) => row.node.id === this.store.selectedNodeId);
    if (selectedIndex < 0) {
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, rows.length - visibleCount));
      return;
    }
    if (selectedIndex < this.scrollOffset) {
      this.scrollOffset = selectedIndex;
    } else if (selectedIndex >= this.scrollOffset + visibleCount) {
      this.scrollOffset = selectedIndex - visibleCount + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, rows.length - visibleCount)));
  }

  private moveSelection(delta: number, rows: TreeRow[]) {
    if (rows.length === 0) {
      return;
    }
    const selectedIndex = rows.findIndex((row) => row.node.id === this.store.selectedNodeId);
    const nextIndex =
      selectedIndex < 0
        ? delta > 0
          ? 0
          : rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
    this.selectRow(rows[nextIndex]);
  }

  private collapseSelected() {
    const selectedId = this.store.selectedNodeId;
    if (selectedId === undefined) {
      return;
    }
    const node = findNode(this.store.tree, selectedId);
    if (!node) {
      return;
    }
    if (node.children.length > 0 && this.expandedIds.has(selectedId)) {
      this.expandedIds.delete(selectedId);
      this.userCollapsedIds.add(selectedId);
      return;
    }
    const parent = findParent(this.store.tree, selectedId);
    if (parent) {
      this.store.selectNode(parent.id);
    }
  }

  private expandSelected(rows: TreeRow[]) {
    const selectedId = this.store.selectedNodeId;
    if (selectedId === undefined) {
      return;
    }
    const index = rows.findIndex((row) => row.node.id === selectedId);
    if (index < 0) {
      return;
    }
    const node = rows[index].node;
    if (node.children.length > 0 && !this.expandedIds.has(selectedId)) {
      this.expandedIds.add(selectedId);
      this.userCollapsedIds.delete(selectedId);
      return;
    }
    if (node.children.length > 0 && index < rows.length - 1) {
      this.store.selectNode(rows[index + 1].node.id);
    }
  }

  private selectRow(row: TreeRow | undefined) {
    if (row) {
      this.store.selectNode(row.node.id);
    }
  }
}
