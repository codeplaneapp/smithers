/** @jsxImportSource react */
import { useSyncExternalStore, type ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { formatRelativeTime } from "./formatRelativeTime";

/**
 * Shared interval store: every mounted RelativeTime/useRelativeTime re-renders
 * off ONE 30s interval (ref-counted; cleared when the last subscriber
 * unmounts) instead of each owning a private timer. The snapshot is a tick
 * counter, so all subscribers re-render in the same pass with the same now.
 */
const TICK_MS = 30_000;
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

/** `formatRelativeTime(ts)` that re-renders on the shared 30s tick. */
export function useRelativeTime(ts: number): string {
  useSyncExternalStore(subscribeRelativeTime, getTick, getServerTick);
  return formatRelativeTime(ts);
}

export type RelativeTimeProps = Omit<ComponentProps<"time">, "children" | "dateTime"> & {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Hover title override; defaults to the full locale date+time string. */
  title?: string;
};

/**
 * Ticking relative timestamp ("3m ago") with the absolute instant in
 * `dateTime`/`title`. Tabular-nums keeps the label from jittering as it ticks.
 */
export function RelativeTime({ ts, title, className, ...props }: RelativeTimeProps) {
  useInjectUiCss();
  const label = useRelativeTime(ts);
  const date = new Date(ts);
  return (
    <time
      data-slot="relative-time"
      className={cn("sui-relative-time", className)}
      dateTime={date.toISOString()}
      title={title ?? date.toLocaleString()}
      {...props}
    >
      {label}
    </time>
  );
}
