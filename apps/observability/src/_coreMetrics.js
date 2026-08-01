import { Context } from "effect";
/** @typedef {import("./_coreMetricsShape.ts").MetricsServiceShape} MetricsServiceShape */

/** @typedef {Context.ServiceClass.Shape<"MetricsService", MetricsServiceShape>} MetricsService */
const MetricsServiceTag = /** @type {Context.ServiceClass<MetricsService, "MetricsService", MetricsServiceShape>} */ (
  Context.Service()("MetricsService")
);
export const MetricsService = /** @type {Context.ServiceClass<MetricsService, "MetricsService", MetricsServiceShape>} */ (
  class MetricsService extends MetricsServiceTag {
    constructor(...args) {
      super(...args);
    }
  }
);
