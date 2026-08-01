import { Context } from "effect";
/** @typedef {import("./_coreMetricsShape.ts").MetricsServiceShape} MetricsServiceShape */

const _MetricsServiceBase = /** @type {Context.ServiceClass<MetricsService, "MetricsService", MetricsServiceShape>} */ (
  /** @type {unknown} */ (Context.Service("MetricsService"))
);
export class MetricsService extends _MetricsServiceBase {}
