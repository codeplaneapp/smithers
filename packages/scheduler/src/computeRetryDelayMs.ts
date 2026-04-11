import type { RetryPolicy } from "./RetryPolicy.ts";
import { retryPolicyToSchedule } from "./retryPolicyToSchedule.ts";
import { retryScheduleDelayMs } from "./retryScheduleDelayMs.ts";

export function computeRetryDelayMs(
  policy: RetryPolicy | undefined,
  attempt: number,
): number {
  if (!policy) return 0;
  return retryScheduleDelayMs(retryPolicyToSchedule(policy), attempt);
}
