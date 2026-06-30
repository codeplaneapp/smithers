import "./timeline.css";
import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useChatStore } from "../chat/chatStore";
import { GATE_FRAME } from "../runs/authRefactorFrames";
import { useRunsStore } from "../runs/runsStore";
import { selectRun } from "../runs/selectRun";
import {
  frameLabel,
  frameMarkers,
  framePct,
  runningAtFrame,
} from "./timeline";
import { useTimelineStore } from "./timelineStore";

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function ClockBack() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none">
      <path
        d="M3 12a9 9 0 1 0 3-6.7M3 5v4h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none">
      <path
        d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Time travel as one strip: a frame scrubber over the run's snapshots. The
 * counter, dots, slider, and ticks all map a frame to the same percentage, so
 * they line up. Scrubbing pins the run paused; Return-to-live snaps back to the
 * head and resumes. Fork branches a new run here, Replay resumes from here, and
 * Rewind destructively truncates the timeline (behind a confirm). All engine
 * mutations route through `runsStore`; this component owns no state.
 */
export function TimelineCanvas({ runId }: { runId: string }) {
  const runs = useRunsStore((state) => state.runs);
  const pendingFrame = useTimelineStore((state) => state.pendingFrame);
  const confirmingRewind = useTimelineStore((state) => state.confirmingRewind);
  const error = useTimelineStore((state) => state.error);
  const scrubTo = useTimelineStore((state) => state.scrubTo);
  const step = useTimelineStore((state) => state.step);
  const jumpToStart = useTimelineStore((state) => state.jumpToStart);
  const jumpToEnd = useTimelineStore((state) => state.jumpToEnd);
  const togglePlay = useTimelineStore((state) => state.togglePlay);
  const returnToLive = useTimelineStore((state) => state.returnToLive);
  const requestRewind = useTimelineStore((state) => state.requestRewind);
  const cancelRewind = useTimelineStore((state) => state.cancelRewind);
  const confirmRewind = useTimelineStore((state) => state.confirmRewind);
  const fork = useTimelineStore((state) => state.fork);
  const replay = useTimelineStore((state) => state.replay);
  const clearError = useTimelineStore((state) => state.clearError);
  const retry = useTimelineStore((state) => state.retry);
  const say = useChatStore((state) => state.say);

  // The display run (resolved status, clamped frame) and the raw run state for
  // the bits selectRun hides: maxFrame (latest reached) and paused/canceled.
  const run = selectRun(runs, runId);
  const raw = runs.find((entry) => entry.id === runId);
  if (!run || !raw) {
    return <div className="surface-empty">Run not found.</div>;
  }

  const latest = run.frameCount - 1;
  const reached = raw.maxFrame;
  // While a scrub is buffered, the slider/dots should already reflect the target
  // so dragging feels live even though the engine commit is debounced.
  const head = pendingFrame ?? run.frame;
  const isDisabled = latest <= 0;
  const isHistorical = head < reached;
  const isFailed = raw.canceled || raw.gate === "denied" || run.status === "failed";
  const isComplete = run.status === "ok" && head >= latest;
  // Rewind is only offered from a historical frame on a still-mutable run, never
  // on a finished or canceled one (Swift hides it for terminal runs).
  const rewindEligible = isHistorical && !raw.canceled && run.status !== "ok";
  const playDisabled = isFailed || isComplete;

  const headPct = framePct(head, latest);
  const frames = Array.from({ length: run.frameCount }, (_, index) => index);
  const ticks = frameMarkers(run.frameCount);
  const runningCount = runningAtFrame(head);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isDisabled) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        step(runId, -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        step(runId, 1);
        break;
      case "Home":
        event.preventDefault();
        jumpToStart(runId);
        break;
      case "End":
        event.preventDefault();
        jumpToEnd(runId);
        break;
      default:
        break;
    }
  }

  return (
    <section className="surface" data-testid="timeline-canvas">
      <header className="surface-head">
        <span className="surface-title">Time travel</span>
        <span className="surface-sub">
          {run.frameCount} snapshots
          {isHistorical ? (
            <>
              {" · "}
              <span className="status-pill tone-waiting" data-testid="tl-historical-pill">
                historical
              </span>
            </>
          ) : null}
        </span>
        <span className="tl-counter" data-testid="tl-counter">
          frame {head} / {latest < 0 ? 0 : latest}
        </span>
      </header>

      <div
        className="timeline"
        data-testid="tl-scrubber"
        tabIndex={0}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={latest < 0 ? 0 : latest}
        aria-valuenow={head}
        aria-label="Run frame scrubber"
        onKeyDown={onKeyDown}
      >
        {isDisabled ? (
          <div className="tl-disabled" data-testid="tl-disabled">
            No earlier frames to scrub.
          </div>
        ) : (
          <>
            <div className="tl-track">
              <span
                className={`tl-fill${isFailed ? " is-failed" : ""}`}
                style={{ width: `${headPct}%` }}
              />
              {frames.map((index) => {
                const pct = framePct(index, latest);
                const done = isComplete || index < head;
                const isHead = index === head;
                return (
                  <button
                    key={index}
                    type="button"
                    aria-label={`Frame ${index}: ${frameLabel(index)}`}
                    title={`${index} · ${frameLabel(index)}`}
                    className={`tl-dot${done ? " is-done" : ""}${isHead ? " is-head" : ""}${
                      isHead && isFailed ? " is-failed" : ""
                    }`}
                    style={{ left: `${pct}%` }}
                    onClick={() => scrubTo(runId, index)}
                  />
                );
              })}
            </div>

            <input
              className="tl-slider"
              type="range"
              min={0}
              max={latest}
              step={1}
              value={head}
              data-testid="tl-slider"
              aria-label="Run frame slider"
              onChange={(event) => scrubTo(runId, Number(event.target.value))}
            />

            <div className="tl-ticks" data-testid="tl-ticks">
              {ticks.map((tick) => (
                <span
                  key={tick.frame}
                  className={`tl-tick${tick.kind === "gate" ? " tl-tick-gate" : ""}`}
                  data-frame={tick.frame}
                  style={{ left: `${framePct(tick.frame, latest)}%` }}
                />
              ))}
            </div>

            <div className="tl-frame-label" data-testid="tl-frame-label">
              {frameLabel(head)}
            </div>

            {error ? (
              <div className="tl-error" data-testid="tl-error" role="alert">
                <WarnIcon />
                <div className="tl-error-text">
                  {error.message}
                  {error.hint ? <div className="tl-error-hint">{error.hint}</div> : null}
                </div>
                <div className="tl-error-actions">
                  {error.retriable ? (
                    <button
                      className="btn"
                      type="button"
                      data-testid="tl-error-retry"
                      onClick={() => retry(runId)}
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    className="btn"
                    type="button"
                    data-testid="tl-error-dismiss"
                    onClick={clearError}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

            {isHistorical ? (
              <div className="tl-historical" data-testid="tl-historical">
                <ClockBack />
                <span>
                  Viewing frame {head} of {reached} (historical).
                </span>
                {runningCount > 0 ? (
                  <span className="tl-historical-running" data-testid="tl-running-count">
                    <PlayIcon />
                    {runningCount} task{runningCount === 1 ? "" : "s"} running at this frame.
                  </span>
                ) : null}
                <button
                  className="btn tl-return-live"
                  type="button"
                  data-testid="tl-return-live"
                  onClick={() => returnToLive(runId)}
                >
                  Return to live
                </button>
              </div>
            ) : null}

            <div className="tl-transport" data-testid="tl-transport">
              <button
                className="btn tl-play"
                type="button"
                data-testid="tl-play"
                disabled={playDisabled}
                onClick={() => togglePlay(runId)}
              >
                {raw.paused ? <PlayIcon /> : <PauseIcon />}
                {raw.paused ? "Play" : "Pause"}
              </button>
              <button
                className="btn tl-step"
                type="button"
                aria-label="Jump to start"
                data-testid="tl-jump-start"
                disabled={head <= 0}
                onClick={() => jumpToStart(runId)}
              >
                ⏮
              </button>
              <button
                className="btn tl-step"
                type="button"
                aria-label="Step back one frame"
                data-testid="tl-step-back"
                disabled={head <= 0}
                onClick={() => step(runId, -1)}
              >
                ‹
              </button>
              <button
                className="btn tl-step"
                type="button"
                aria-label="Step forward one frame"
                data-testid="tl-step-fwd"
                disabled={head >= latest}
                onClick={() => step(runId, 1)}
              >
                ›
              </button>
              <button
                className="btn tl-step"
                type="button"
                aria-label="Jump to end"
                data-testid="tl-jump-end"
                disabled={head >= latest}
                onClick={() => jumpToEnd(runId)}
              >
                ⏭
              </button>
            </div>

            <div className="tl-actions" data-testid="tl-actions">
              <button
                className="btn btn-brand"
                type="button"
                data-testid="tl-fork"
                onClick={() => fork(runId)}
              >
                Fork from here
              </button>
              <button
                className="btn"
                type="button"
                data-testid="tl-replay"
                onClick={() => replay(runId)}
              >
                Replay
              </button>
              {rewindEligible ? (
                <button
                  className="btn tl-rewind"
                  type="button"
                  data-testid="tl-rewind"
                  onClick={() => requestRewind(runId, head)}
                >
                  Rewind run to here
                </button>
              ) : null}
            </div>

            {confirmingRewind ? (
              <div className="tl-rewind-confirm" data-testid="tl-rewind-confirm">
                <WarnIcon />
                <span>
                  Rewind to frame {head} ({frameLabel(head)})? This drops every later frame and
                  resumes from here.
                </span>
                <div className="tl-rewind-confirm-actions">
                  <button
                    className="btn tl-rewind"
                    type="button"
                    data-testid="tl-rewind-confirm-btn"
                    onClick={() => confirmRewind(runId, head)}
                  >
                    Rewind
                  </button>
                  <button
                    className="btn"
                    type="button"
                    data-testid="tl-rewind-cancel"
                    onClick={cancelRewind}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Gate-pause hint: the heartbeat parks at the deploy gate until approved,
          so call it out near the transport. */}
      {!isDisabled && raw.gate === "pending" ? (
        <div className="tl-frame-label" data-testid="tl-gate-hint" style={{ margin: "0 8px 10px" }}>
          Paused at the deploy gate (frame {GATE_FRAME}). Approve it to keep advancing.
        </div>
      ) : null}

      {/* Surface a one-off way to demo the error path without a real failure. */}
      {!isDisabled && !error ? (
        <button
          className="card-link"
          type="button"
          data-testid="tl-simulate-error"
          style={{ margin: "0 8px 12px" }}
          onClick={() => {
            useTimelineStore.getState().setError({
              message: "Couldn't reach the frame snapshot.",
              hint: "The engine was busy; retry to re-sync to the live frame.",
              retriable: true,
            });
            say("Timeline scrub failed: couldn't reach the frame snapshot.");
          }}
        >
          Simulate a scrub error
        </button>
      ) : null}
    </section>
  );
}
