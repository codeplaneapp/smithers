/**
 * The time-travel scrubber's pure layer. The timeline replays the demo run's
 * snapshots (`AUTH_REFACTOR_FRAMES`, 7 frames, indices 0..6) as a frame strip;
 * the canvas scrubs through them while the heartbeat in `runsStore` advances the
 * live head. Nothing here touches a clock or a gateway, so the marker maths, the
 * per-frame labels, and the running-task walk are unit-tested without a DOM
 * (see timelineDomain.test.ts).
 *
 * Mirrors the Swift TimelineView's notableFrames()/markerX/frame labels, ported
 * verbatim so the dots, ticks, and counter line up exactly.
 */
import { AUTH_REFACTOR_FRAMES, GATE_FRAME } from "../runs/authRefactorFrames";
import type { RunNode } from "../runs/Run";

/** The deploy-gate frame, re-exported so the canvas tags one tick as the gate. */
export const GATE_MARKER = GATE_FRAME;

/** A tick beneath the track: a quarter/half/three-quarter notch, or the gate. */
export type FrameMarker = {
  frame: number;
  kind: "notable" | "gate";
};

/**
 * The notable frames: 0, the ¼/½/¾ marks (Swift notableFrames(), floored over
 * the frame count), and the latest frame. De-duped and sorted ascending, since
 * a short run collapses several fractions onto the same index. For 7 frames this
 * is [0, 1, 3, 5, 6].
 */
export function NOTABLE_FRAME_MARKERS(frameCount: number): number[] {
  const latest = frameCount - 1;
  if (latest <= 0) {
    return frameCount > 0 ? [0] : [];
  }
  const raw = [
    0,
    Math.floor(frameCount / 4),
    Math.floor(frameCount / 2),
    Math.floor((frameCount * 3) / 4),
    latest,
  ];
  const seen = new Set<number>();
  const marks: number[] = [];
  for (const frame of raw) {
    const clamped = Math.max(0, Math.min(latest, frame));
    if (!seen.has(clamped)) {
      seen.add(clamped);
      marks.push(clamped);
    }
  }
  return marks.sort((a, b) => a - b);
}

/**
 * The full tick set the canvas renders: the notable frames plus the gate frame
 * tagged `gate`, de-duped (the gate wins when it collides with a notable mark)
 * and sorted ascending so ticks and dots share the same left→right order.
 */
export function frameMarkers(frameCount: number): FrameMarker[] {
  const latest = frameCount - 1;
  const byFrame = new Map<number, FrameMarker>();
  for (const frame of NOTABLE_FRAME_MARKERS(frameCount)) {
    byFrame.set(frame, { frame, kind: "notable" });
  }
  if (GATE_MARKER >= 0 && GATE_MARKER <= latest) {
    byFrame.set(GATE_MARKER, { frame: GATE_MARKER, kind: "gate" });
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** Per-frame label, deterministic — the run's step at that snapshot. */
const FRAME_LABELS = [
  "planning",
  "editing auth/session.ts",
  "writing auth/token.ts",
  "running tests",
  "deploy gate (waiting)",
  "deploying",
  "done",
];

/** The human label for a frame index, clamped to the seeded range. */
export function frameLabel(frameIndex: number): string {
  if (frameIndex < 0) return FRAME_LABELS[0];
  if (frameIndex >= FRAME_LABELS.length) return FRAME_LABELS[FRAME_LABELS.length - 1];
  return FRAME_LABELS[frameIndex];
}

/** Count nodes with `status === "running"` in a frame's RunNode subtree. */
function countRunning(node: RunNode): number {
  let count = node.status === "running" ? 1 : 0;
  for (const child of node.children ?? []) {
    count += countRunning(child);
  }
  return count;
}

/**
 * How many tasks are running at a given frame — walk that frame's snapshot tree
 * and tally the running nodes. Drives the historical banner's "K tasks running"
 * pill. Out-of-range frames report 0.
 */
export function runningAtFrame(frameIndex: number): number {
  const frame = AUTH_REFACTOR_FRAMES[frameIndex];
  if (!frame) return 0;
  return countRunning(frame);
}

/** Clamp a target frame into the scrubbable range [0, latest]. */
export function clampFrame(frame: number, latest: number): number {
  return Math.max(0, Math.min(latest, frame));
}

/** The left-offset percentage for a frame, shared by dots, fill, and ticks. */
export function framePct(frame: number, latest: number): number {
  if (latest <= 0) return 0;
  return (frame / latest) * 100;
}
