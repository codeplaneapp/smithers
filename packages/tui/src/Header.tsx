/** @jsxImportSource @opentui/react */
import { useEffect, useState } from "react";
import { useRun } from "./data.ts";
import {
  buildRunHeaderData,
  statusDotColor,
  runLiveLabel,
  formatElapsed,
  shortRunId,
  isRunningStatus,
  type RunHeaderData,
} from "./headerUtils.ts";

/**
 * Presentational run header — the documented headline:
 *   ● workflow-name  run-abc123  model  02:34  [live]
 * Takes ALL data as a prop (no gateway hooks, no clock) so it renders
 * deterministically in tests with injected run data. The connected {@link Header}
 * wrapper supplies the live data + ticking clock.
 *
 * Frame counter (n/total): intentionally OMITTED. The monitor subscribes to the
 * run-event stream, which carries no `_smithers_frames.frame_no` total, so there
 * is no honest frame count to show here — we don't fabricate one.
 */
export function RunHeaderView({ data, compact }: { data: RunHeaderData; compact: boolean }) {
  const { status, workflowKey, runId, model, elapsedMs, live } = data;
  const dot = statusDotColor(status);
  const liveLabel = runLiveLabel(status);
  const id = shortRunId(runId);
  const elapsed = formatElapsed(elapsedMs);
  const name = workflowKey ?? "(workflow)";

  if (compact) {
    // Tight single line: dot + id + status + live/paused.
    return (
      <box width="100%" height={1} flexDirection="row">
        <text fg={dot}>{"● "}</text>
        <text fg="#cccccc">{`${id} `}</text>
        <text fg="#888888">{`${status} `}</text>
        <text fg={liveLabel.color}>{`[${liveLabel.text}]`}</text>
      </box>
    );
  }

  return (
    <box width="100%" height={1} flexDirection="row">
      <text fg={dot}>{"● "}</text>
      <text fg="#ffffff">{`${name}  `}</text>
      <text fg="#888888">{`${id}  `}</text>
      {model ? <text fg="#5f87af">{`${model}  `}</text> : null}
      <text fg={isRunningStatus(status) ? "#00d7ff" : "#888888"}>{`${elapsed}  `}</text>
      <text fg={liveLabel.color}>{`[${liveLabel.text}]`}</text>
    </box>
  );
}

/**
 * Gateway-connected header. Pulls the live run row via `useRun` and ticks a 1s
 * clock WHILE the run is running so the elapsed time advances; the interval is
 * torn down once the run is no longer live (or on unmount) so a finished run
 * doesn't keep re-rendering. All presentation lives in {@link RunHeaderView}.
 */
export function Header({ runId, compact }: { runId: string; compact: boolean }) {
  const { data, loading } = useRun(runId);
  const [now, setNow] = useState(() => Date.now());

  const status = loading ? "connecting" : ((data?.["status"] as string | undefined) ?? "unknown");
  const live = isRunningStatus(status);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    return () => clearInterval(timer);
  }, [live]);

  const headerData = buildRunHeaderData(data as Record<string, unknown> | undefined, runId, now, loading);
  return <RunHeaderView data={headerData} compact={compact} />;
}
