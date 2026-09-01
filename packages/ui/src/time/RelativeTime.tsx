/** @jsxImportSource react */
import { useSyncExternalStore, type ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { formatRelativeTime } from "./formatRelativeTime";

/**
 * Shared interval store: every mounted RelativeTime/useRelativeTime re-renders
 * off ONE interval (ref-counted; cleared when the last subscriber unmounts)
 * instead of each owning a private timer. The snapshot is a tick counter, so
 * all subscribers re-render in the same pass with the same now.
 *
 * The period is one second because {@link formatRelativeTime} has one-second
 * granularity below a minute: a longer period would render a label that is
 * visibly wrong for as long as the period lasts. The saving this store exists
 * for is having ONE timer for a page of timestamps, not a long one.
 */
export const TICK_MS = 1_000;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function subscribeRelativeTime(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      tick += 1;
      for (const listener of listeners) listener();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getTick(): number {
  return tick;
}

function getServerTick(): number {
  return 0;
}

/** `formatRelativeTime(ts)` that re-renders on the shared {@link TICK_MS} tick. */
export function useRelativeTime(ts: number): string {
  useSyncExternalStore(subscribeRelativeTime, getTick, getServerTick);
  return formatRelativeTime(ts);
}

export type RelativeTimeProps = Omit<ComponentProps<"time">, "children" | "dateTime"> & {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Hover title override; defaults to the full locale date+time string. */
  title?: string;
  /** Switch to an absolute locale time after this many milliseconds. */
  relativeUntilMs?: number;
};

/**
 * Ticking relative timestamp ("3m ago") with the absolute instant in
 * `dateTime`/`title`. Tabular-nums keeps the label from jittering as it ticks.
 */
/** The ECMAScript time-value range; anything outside it is not a date. */
const MAX_TIME_VALUE = 8.64e15;

export function RelativeTime({ ts, title, relativeUntilMs, className, ...props }: RelativeTimeProps) {
  useInjectUiCss();
  const label = useRelativeTime(ts);
  // `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`,
  // which would take down the whole render for one bad row. A timestamp
  // outside the representable range simply has no absolute instant to state.
  const representable = Number.isFinite(ts) && Math.abs(ts) <= MAX_TIME_VALUE;
  const date = new Date(representable ? ts : 0);
  const display = representable && relativeUntilMs !== undefined && Date.now() - ts >= relativeUntilMs
    ? date.toLocaleTimeString(undefined, { timeStyle: "medium" })
    : label;
  return (
    <time
      data-slot="relative-time"
      className={cn("sui-relative-time", className)}
      {...(representable
        ? { dateTime: date.toISOString(), title: title ?? date.toLocaleString() }
        : title === undefined
        ? {}
        : { title })}
      {...props}
    >
      {display}
    </time>
  );
}
