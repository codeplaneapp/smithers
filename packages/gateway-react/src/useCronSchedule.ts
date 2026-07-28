import { useMemo } from "react";
import { useGatewayCrons } from "./useGatewayCrons.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";
import { cronToCalendarEvents, type CronScheduleEvent } from "./cronSchedule.ts";

export type UseCronScheduleOptions = {
  /** Window start, epoch ms (inclusive). Day-aligned values keep useMemo stable. */
  windowStart: number;
  /** Window end, epoch ms (exclusive). */
  windowEnd: number;
  /** Max expanded occurrences per cron (default 250) so `* * * * *` cannot flood the view. */
  perCronLimit?: number;
};

/**
 * Expand every cron's upcoming occurrences within the window into calendar
 * events (`@smithers-orchestrator/ui/calendar`-shaped). Async state passes
 * straight through from {@link useGatewayCrons}; `data` stays undefined until
 * the first populated snapshot, then is a chronologically sorted event list.
 */
export function useCronSchedule({
  windowStart,
  windowEnd,
  perCronLimit,
}: UseCronScheduleOptions): GatewayAsyncState<CronScheduleEvent[]> {
  const crons = useGatewayCrons();
  const data = useMemo(() => {
    if (!crons.data) return undefined;
    return crons.data
      .flatMap((cron) => cronToCalendarEvents(cron, windowStart, windowEnd, perCronLimit))
      .sort((a, b) => a.start - b.start);
  }, [crons.data, windowStart, windowEnd, perCronLimit]);

  return { data, error: crons.error, loading: crons.loading, refetch: crons.refetch };
}
