import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { DevToolsStore } from "../runtime/DevToolsStore.js";
import type { DevToolsClient } from "../runtime/DevToolsClient.js";
import { FrameScrubber } from "./FrameScrubber.js";
import { Header } from "./Header.js";
import { NodeInspector } from "./NodeInspector.js";
import { RunTree } from "./RunTree.js";

type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

type FocusPane = "tree" | "inspector" | "scrubber";

type RunInspectorOptions = {
  workflowName?: string;
  theme?: Theme;
  onClose?: () => void;
  onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
};

function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

function stripAnsi(value: string) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function padRight(value: string, width: number) {
  const plain = stripAnsi(value);
  return plain.length >= width ? value : value + " ".repeat(width - plain.length);
}

function joinPanes(left: string, right: string, leftWidth: number, rightWidth: number) {
  return `${padRight(truncateToWidth(left, leftWidth), leftWidth)} ${truncateToWidth(right, rightWidth)}`;
}

export class RunInspector {
  private readonly header: Header;
  private readonly scrubber: FrameScrubber;
  private readonly tree: RunTree;
  private readonly inspector: NodeInspector;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly onNotify: (message: string, level?: "info" | "warning" | "error") => void;
  private readonly unsubscribeStore: () => void;
  private focus: FocusPane = "tree";
  private cachedLines: string[] | undefined;
  private cachedWidth = 0;

  constructor(
    private readonly store: DevToolsStore,
    private readonly client: DevToolsClient,
    options: RunInspectorOptions = {},
  ) {
    this.header = new Header(store, options.workflowName);
    this.scrubber = new FrameScrubber(store);
    this.tree = new RunTree(store);
    this.inspector = new NodeInspector(store);
    this.theme = options.theme ?? {};
    this.onClose = options.onClose ?? (() => undefined);
    this.onNotify = options.onNotify ?? (() => undefined);
    this.unsubscribeStore = store.subscribe(() => this.invalidate());
  }

  handleInput(data: string) {
    this.invalidate();
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.cycleFocus(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.cycleFocus(-1);
      return;
    }
    if (matchesKey(data, "a")) {
      void this.approveSelected();
      return;
    }
    if (matchesKey(data, "d")) {
      void this.denySelected();
      return;
    }
    if (matchesKey(data, "c")) {
      void this.cancelRun();
      return;
    }
    if (matchesKey(data, "l")) {
      this.store.returnToLive();
      return;
    }
    if (matchesKey(data, "w")) {
      void this.rewindDisplayedFrame();
      return;
    }
    if (matchesKey(data, "s")) {
      this.focus = "scrubber";
      return;
    }
    if (this.focus === "scrubber" && this.scrubber.handleInput(data)) {
      return;
    }
    if (this.focus === "inspector") {
      const result = this.inspector.handleInput(data);
      if (result === "handled") {
        return;
      }
    }
    const treeResult = this.tree.handleInput(data);
    if (treeResult === "focusInspector") {
      this.focus = "inspector";
    }
  }

  render(width: number, height = 34, theme: Theme = this.theme) {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const W = Math.max(60, width);
    const H = Math.max(18, height);
    const lines: string[] = [];
    lines.push(...this.header.render(W, theme));
    if (this.store.isStaleBannerVisible) {
      const since = this.store.staleSince ? Math.max(0, Math.floor((Date.now() - this.store.staleSince.getTime()) / 1_000)) : 0;
      lines.push(truncateToWidth(paint(theme, "warning", ` stale: gateway disconnected for ${since}s; showing last known tree`), W));
    }
    lines.push(...this.scrubber.render(W, theme));

    const bodyHeight = Math.max(8, H - lines.length - 2);
    const leftWidth = Math.max(30, Math.min(Math.floor(W * 0.46), W - 31));
    const rightWidth = Math.max(24, W - leftWidth - 1);
    const left = this.tree.render(leftWidth, bodyHeight, theme);
    const right = this.inspector.render(rightWidth, bodyHeight, theme);
    for (let index = 0; index < bodyHeight; index += 1) {
      lines.push(joinPanes(left[index] ?? "", right[index] ?? "", leftWidth, rightWidth));
    }

    const focusLabel = paint(theme, "accent", this.focus);
    lines.push(
      truncateToWidth(
        paint(
          theme,
          "dim",
          ` focus:${stripAnsi(focusLabel)}  tab:focus  arrows/jk:tree  1-3:tabs  s:frames  a/d:approve/deny  w:rewind  c:cancel  q:close`,
        ),
        W,
      ),
    );
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate() {
    this.cachedLines = undefined;
    this.cachedWidth = 0;
  }

  dispose() {
    this.unsubscribeStore();
    this.store.disconnect();
  }

  private cycleFocus(delta: number) {
    const panes: FocusPane[] = ["tree", "inspector", "scrubber"];
    const current = panes.indexOf(this.focus);
    this.focus = panes[(current + delta + panes.length) % panes.length];
  }

  private selectedTask() {
    const node = this.store.selectedNode;
    const runId = this.store.runId;
    const nodeId = node?.task?.nodeId;
    if (!runId || !nodeId) {
      return undefined;
    }
    return {
      runId,
      nodeId,
      iteration: node.task?.iteration ?? 0,
    };
  }

  private async approveSelected() {
    const task = this.selectedTask();
    if (!task) {
      this.onNotify("No task node selected.", "warning");
      return;
    }
    try {
      await this.client.approve(task.runId, task.nodeId, task.iteration);
      this.onNotify(`Approved ${task.nodeId}.`, "info");
    } catch (error) {
      this.onNotify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async denySelected() {
    const task = this.selectedTask();
    if (!task) {
      this.onNotify("No task node selected.", "warning");
      return;
    }
    try {
      await this.client.deny(task.runId, task.nodeId, task.iteration);
      this.onNotify(`Denied ${task.nodeId}.`, "warning");
    } catch (error) {
      this.onNotify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async cancelRun() {
    if (!this.store.runId) {
      return;
    }
    try {
      await this.client.cancel(this.store.runId);
      this.onNotify(`Cancelling ${this.store.runId.slice(0, 8)}.`, "warning");
    } catch (error) {
      this.onNotify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async rewindDisplayedFrame() {
    if (!this.store.isRewindEligible) {
      this.onNotify("Rewind is only available while viewing a historical frame for a live run.", "warning");
      return;
    }
    await this.store.rewind(this.store.displayedFrameNo, true);
  }
}
