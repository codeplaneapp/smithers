import { smithersMetricCatalog } from "./smithersMetricCatalog.js";
export const smithersMetricCatalogByKey = new Map(smithersMetricCatalog.map((metric) => [metric.key, metric]));
