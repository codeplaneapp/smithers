import { smithersMetricCatalog } from "./smithersMetricCatalog.js";
export const smithersMetricCatalogByPrometheusName = new Map(smithersMetricCatalog.map((metric) => [metric.prometheusName, metric]));
