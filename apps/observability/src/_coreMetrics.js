import { Context } from "effect";
/** @typedef {import("./_coreMetricsShape.ts").MetricsServiceShape} MetricsServiceShape */

const _MetricsServiceBase = /** @type {Context.TagClass<MetricsService, "MetricsService", MetricsServiceShape>} */ (/** @type {unknown} */ (Context.Tag("MetricsService")()));
export class MetricsService extends _MetricsServiceBase {
}
