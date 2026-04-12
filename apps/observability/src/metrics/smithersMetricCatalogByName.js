import { smithersMetricCatalog } from "./smithersMetricCatalog.js";
export const smithersMetricCatalogByName = new Map(smithersMetricCatalog.map((metric) => [metric.name, metric]));
