import { Effect, Metric } from "effect";
import { processStartMs } from "./_processStartMs.js";
import { processUptimeSeconds } from "./processUptimeSeconds.js";
import { processMemoryRssBytes } from "./processMemoryRssBytes.js";
import { processHeapUsedBytes } from "./processHeapUsedBytes.js";
/**
 * @returns {Effect.Effect<void>}
 */
export function updateProcessMetrics() {
    const uptimeS = (Date.now() - processStartMs) / 1000;
    const mem = process.memoryUsage();
    return Effect.all([
        Metric.set(processUptimeSeconds, uptimeS),
        Metric.set(processMemoryRssBytes, mem.rss),
        Metric.set(processHeapUsedBytes, mem.heapUsed),
    ], { discard: true });
}
