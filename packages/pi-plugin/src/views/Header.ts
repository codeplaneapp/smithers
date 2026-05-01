import { truncateToWidth } from "@mariozechner/pi-tui";
import type { DevToolsStore } from "../runtime/DevToolsStore.js";

type Theme = {
  fg?: (color: string, value: string) => string;
  bold?: (value: string) => string;
};

function paint(theme: Theme, color: string, value: string) {
  return theme.fg ? theme.fg(color, value) : value;
}

function bold(theme: Theme, value: string) {
  return theme.bold ? theme.bold(value) : value;
}

function stateColor(status: string) {
  switch (status) {
    case "running":
      return "accent";
    case "finished":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "dim";
    case "waiting-approval":
      return "warning";
    default:
      return "muted";
  }
}

function heartbeatColor(ageMs: number, heartbeatMs: number) {
  const interval = Math.max(heartbeatMs, 1);
  if (!Number.isFinite(ageMs)) {
    return "error";
  }
  if (ageMs <= interval * 2) {
    return "success";
  }
  if (ageMs <= interval * 5) {
    return "warning";
  }
  return "error";
}

function numberField(value: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const raw = value?.[key];
    if (typeof raw === "number") {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function stringField(value: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const raw = value?.[key];
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  }
  return undefined;
}

function dateMs(value: Record<string, unknown> | undefined, msKeys: string[], isoKeys: string[]) {
  const ms = numberField(value, msKeys);
  if (ms !== undefined) {
    return ms;
  }
  const iso = stringField(value, isoKeys);
  if (!iso) {
    return undefined;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class Header {
  constructor(
    private readonly store: DevToolsStore,
    private readonly workflowName = "workflow",
  ) {}

  render(width: number, theme: Theme) {
    const W = Math.max(40, width);
    const runId = this.store.runId ?? "no-run";
    const state = this.store.runStatus;
    const runState = this.store.runStateView;
    const engineHeartbeatMs =
      numberField(runState, ["engineHeartbeatMs", "engine_heartbeat_ms"]) ?? 1_000;
    const engineLastMs =
      dateMs(
        runState,
        ["engineHeartbeatAtMs", "engine_heartbeat_at_ms"],
        ["engineHeartbeatAt", "engine_heartbeat_at"],
      ) ?? this.store.lastEventAt?.getTime();
    const sandboxHeartbeatMs =
      numberField(runState, [
        "viewersHeartbeatMs",
        "viewers_heartbeat_ms",
        "uiHeartbeatMs",
        "ui_heartbeat_ms",
      ]) ?? engineHeartbeatMs;
    const sandboxLastMs = dateMs(
      runState,
      ["viewersHeartbeatAtMs", "viewers_heartbeat_at_ms", "uiHeartbeatAtMs", "ui_heartbeat_at_ms"],
      ["viewersHeartbeatAt", "viewers_heartbeat_at", "uiHeartbeatAt", "ui_heartbeat_at"],
    );
    const now = Date.now();
    const engineAge = engineLastMs === undefined ? Number.POSITIVE_INFINITY : now - engineLastMs;
    const sandboxAge = sandboxLastMs === undefined ? Number.POSITIVE_INFINITY : now - sandboxLastMs;
    const runStateLabel = stringField(runState, ["state"]);
    const connection =
      this.store.connectionState.kind === "streaming"
        ? ""
        : ` ${paint(theme, "warning", this.store.connectionState.kind)}`;
    const left = [
      paint(theme, stateColor(state), bold(theme, state.toUpperCase())),
      paint(theme, "muted", this.workflowName),
      paint(theme, "dim", runId.slice(0, 12)),
      runStateLabel ? paint(theme, "muted", runStateLabel) : "",
    ].filter(Boolean).join("  ");
    const right = [
      `${paint(theme, heartbeatColor(engineAge, engineHeartbeatMs), "eng")}:${Math.max(0, Math.floor(engineAge / 1_000))}s`,
      `${paint(theme, heartbeatColor(sandboxAge, sandboxHeartbeatMs), "box")}:${Number.isFinite(sandboxAge) ? Math.max(0, Math.floor(sandboxAge / 1_000)) : "--"}s`,
      paint(theme, "dim", `seq ${this.store.seq}`),
      connection,
    ].filter(Boolean).join("  ");
    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const plainLeft = left.replace(ansiPattern, "");
    const plainRight = right.replace(ansiPattern, "");
    const gap = Math.max(1, W - plainLeft.length - plainRight.length - 2);
    return [truncateToWidth(` ${left}${" ".repeat(gap)}${right} `, W)];
  }
}
