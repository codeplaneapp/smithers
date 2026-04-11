import type { RunTimeline } from "./RunTimeline";

/**
 * Recursive timeline tree including forks.
 */
export type TimelineTree = {
  timeline: RunTimeline;
  children: TimelineTree[];
};
