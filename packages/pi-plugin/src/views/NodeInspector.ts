import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { DevToolsNode } from "@smithers-orchestrator/protocol";
import type { DevToolsStore } from "../runtime/DevToolsStore.js";

type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

type InspectorTab = "output" | "diff" | "logs";

function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

function bold(theme: Theme, value: string) {
  return theme.bold ? theme.bold(value) : value;
}

function compact(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nodeState(node: DevToolsNode) {
  const raw = node.props.state;
  return typeof raw === "string" ? raw : "unknown";
}

function errorText(node: DevToolsNode) {
  const keys = ["error", "errors", "failure", "exception"];
  for (const key of keys) {
    const value = node.props[key];
    if (value !== undefined) {
      return compact(value);
    }
  }
  return undefined;
}

function firstPresent(node: DevToolsNode, keys: string[]) {
  for (const key of keys) {
    if (node.props[key] !== undefined) {
      return node.props[key];
    }
  }
  return undefined;
}

function renderJsonLines(value: unknown, fallback: string) {
  const text = value === undefined ? fallback : compact(value);
  return text.split("\n").map((line) => ` ${line}`);
}

function toolCalls(node: DevToolsNode) {
  const value = firstPresent(node, ["toolCalls", "tool_calls", "tools"]);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (typeof item !== "object" || item === null) {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const name =
        record.name ?? record.tool ?? record.toolName ?? record.function ?? `tool-call-${index + 1}`;
      const status = record.status ?? record.state;
      const effect = record.sideEffect ?? record.side_effect ?? record.effect;
      return [name, status, effect].filter((part) => typeof part === "string" && part.length > 0).join(" ");
    })
    .filter((item): item is string => Boolean(item));
}

export class NodeInspector {
  private tab: InspectorTab = "output";
  private scrollOffset = 0;

  constructor(private readonly store: DevToolsStore) {}

  handleInput(data: string) {
    if (matchesKey(data, "1")) {
      this.tab = "output";
      this.scrollOffset = 0;
      return "handled";
    }
    if (matchesKey(data, "2")) {
      this.tab = "diff";
      this.scrollOffset = 0;
      return "handled";
    }
    if (matchesKey(data, "3")) {
      this.tab = "logs";
      this.scrollOffset = 0;
      return "handled";
    }
    if (matchesKey(data, "tab") || matchesKey(data, "]")) {
      this.nextTab(1);
      return "handled";
    }
    if (matchesKey(data, "[")) {
      this.nextTab(-1);
      return "handled";
    }
    if (matchesKey(data, "j") || data === "\x1b[B") {
      this.scrollOffset += 1;
      return "handled";
    }
    if (matchesKey(data, "k") || data === "\x1b[A") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return "handled";
    }
    if (matchesKey(data, "g")) {
      this.scrollOffset = 0;
      return "handled";
    }
    return "unhandled";
  }

  render(width: number, height: number, theme: Theme) {
    const W = Math.max(28, width);
    const H = Math.max(4, height);
    const node = this.store.selectedNode;
    if (!node) {
      return this.pad([paint(theme, "muted", " select a node to inspect")], H);
    }

    const lines: string[] = [];
    const title = `${node.task?.nodeId ?? node.name}  ${nodeState(node)}`;
    lines.push(truncateToWidth(` ${paint(theme, "accent", bold(theme, title))}`, W));

    const error = errorText(node);
    if (error) {
      lines.push(truncateToWidth(` ${paint(theme, "error", error.split("\n")[0] ?? "error")}`, W));
    }

    if (this.store.isGhost) {
      const unmounted = this.store.selectedGhostRecord?.unmountedFrameNo;
      lines.push(
        truncateToWidth(
          paint(
            theme,
            "warning",
            ` ghost: node no longer mounted${unmounted === undefined ? "" : ` at frame ${unmounted}`}`,
          ),
          W,
        ),
      );
    }

    const tabs = (["output", "diff", "logs"] as InspectorTab[])
      .map((tab, index) => {
        const label = `${index + 1}:${tab}`;
        return tab === this.tab ? paint(theme, "accent", bold(theme, `[${label}]`)) : paint(theme, "dim", label);
      })
      .join(" ");
    lines.push(truncateToWidth(` ${tabs}`, W));

    const body = this.bodyLines(node);
    const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + Math.max(1, H - lines.length));
    for (const line of visibleBody) {
      lines.push(truncateToWidth(line, W));
    }
    return this.pad(lines, H).slice(0, H);
  }

  private bodyLines(node: DevToolsNode) {
    const calls = toolCalls(node);
    const taskLines = [
      ` task.nodeId: ${node.task?.nodeId ?? "-"}`,
      ` task.kind: ${node.task?.kind ?? "-"}`,
      ` task.agent: ${node.task?.agent ?? "-"}`,
      ` task.iteration: ${node.task?.iteration ?? 0}`,
    ];
    const callLines = calls.length > 0 ? ["", " tool calls:", ...calls.map((call) => `  - ${call}`)] : [];
    switch (this.tab) {
      case "output":
        return [
          ...taskLines,
          ...callLines,
          "",
          " output:",
          ...renderJsonLines(firstPresent(node, ["output", "row", "result", "value"]), " (no output captured)"),
        ];
      case "diff":
        return [
          ...taskLines,
          "",
          " diff:",
          ...renderJsonLines(firstPresent(node, ["diff", "patches", "changes"]), " (no diff captured)"),
        ];
      case "logs":
        return [
          ...taskLines,
          "",
          " logs:",
          ...renderJsonLines(firstPresent(node, ["logs", "log", "stdout", "stderr"]), " (no logs captured)"),
        ];
    }
  }

  private nextTab(delta: number) {
    const tabs: InspectorTab[] = ["output", "diff", "logs"];
    const current = tabs.indexOf(this.tab);
    this.tab = tabs[(current + delta + tabs.length) % tabs.length];
    this.scrollOffset = 0;
  }

  private pad(lines: string[], height: number) {
    while (lines.length < height) {
      lines.push("");
    }
    return lines;
  }
}
