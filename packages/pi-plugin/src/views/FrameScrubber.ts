import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { DevToolsStore } from "../runtime/DevToolsStore.js";

type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

export class FrameScrubber {
  constructor(private readonly store: DevToolsStore) {}

  handleInput(data: string) {
    if (matchesKey(data, "left") || data === "\x1b[D" || matchesKey(data, ",")) {
      void this.store.scrubTo(Math.max(0, this.store.displayedFrameNo - 1));
      return true;
    }
    if (matchesKey(data, "right") || data === "\x1b[C" || matchesKey(data, ".")) {
      void this.store.scrubTo(Math.min(this.store.latestFrameNo, this.store.displayedFrameNo + 1));
      return true;
    }
    if (matchesKey(data, "home")) {
      void this.store.scrubTo(0);
      return true;
    }
    if (matchesKey(data, "end")) {
      this.store.returnToLive();
      return true;
    }
    return false;
  }

  render(width: number, theme: Theme) {
    const W = Math.max(24, width);
    const latest = Math.max(0, this.store.latestFrameNo);
    const current = Math.min(this.store.displayedFrameNo, latest);
    const barWidth = Math.max(10, W - 24);
    const position = latest <= 0 ? 0 : Math.round((current / latest) * (barWidth - 1));
    const chars = Array.from({ length: barWidth }, (_, index) => (index === position ? "|" : "-"));
    const mode = this.store.mode.kind === "historical" ? paint(theme, "warning", "historical") : paint(theme, "success", "live");
    const lines = [
      truncateToWidth(
        ` frame ${String(current).padStart(3)} / ${String(latest).padEnd(3)} ${paint(theme, "border", chars.join(""))} ${mode}`,
        W,
      ),
    ];
    if (this.store.mode.kind === "historical") {
      const running =
        this.store.runningNodeCount > 0
          ? ` ${this.store.runningNodeCount} running at this frame.`
          : "";
      lines.push(
        truncateToWidth(
          paint(theme, "warning", ` viewing stale frame ${current}; live has ${latest}.${running}`),
          W,
        ),
      );
    }
    if (this.store.scrubError || this.store.rewindError) {
      lines.push(
        truncateToWidth(
          paint(theme, "error", ` ${(this.store.rewindError ?? this.store.scrubError)?.message ?? "frame error"}`),
          W,
        ),
      );
    }
    return lines;
  }
}
