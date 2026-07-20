import { smithersMetricCatalog } from "./metrics/index.js";
export const smithersMetrics = Object.fromEntries(smithersMetricCatalog.map((metric) => [metric.key, metric.metric]));
