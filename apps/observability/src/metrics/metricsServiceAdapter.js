import { renderPrometheusSamples } from "../_corePrometheus.js";
import { Effect, Metric } from "effect";
import { toPrometheusMetricName } from "./toPrometheusMetricName.js";
import { durationBuckets } from "./_buckets.js";
import { smithersMetricCatalogByName } from "./smithersMetricCatalogByName.js";
import { smithersMetricCatalogByPrometheusName } from "./smithersMetricCatalogByPrometheusName.js";
import { trackEvent } from "./trackEvent.js";
import { updateProcessMetrics } from "./updateProcessMetrics.js";
import { updateAsyncExternalWaitPending } from "./updateAsyncExternalWaitPending.js";
import { incrementGauge } from "./_incrementGauge.js";
/** @typedef {import("./SmithersMetricDefinition.ts").SmithersMetricDefinition} SmithersMetricDefinition */
/** @typedef {import("../_coreMetricsShape.ts").MetricsServiceShape} MetricsServiceShape */
/** @typedef {import("../_corePrometheusShape.ts").MetricLabels} MetricLabels */
/** @typedef {import("../_corePrometheusShape.ts").PrometheusSample} PrometheusSample */
/** @typedef {import("../_coreMetricsShape.ts").MetricsSnapshot} MetricsSnapshot */

/**
 * @param {string} name
 * @returns {SmithersMetricDefinition | undefined}
 */
function resolveMetricDefinition(name) {
  return (
    smithersMetricCatalogByName.get(name) ?? smithersMetricCatalogByPrometheusName.get(toPrometheusMetricName(name))
  );
}
/**
 * @template A
 * @param {A} metric
 * @param {MetricLabels} [labels]
 * @returns {A}
 */
function tagMetricWithLabels(metric, labels) {
  let tagged = metric;
  for (const [key, value] of Object.entries(labels ?? {})) {
    tagged = Metric.withAttributes(tagged, { [key]: String(value) });
  }
  return tagged;
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, any>}
 */
function counterOrGaugeMetric(name, labels) {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "counter" || definition?.type === "gauge" ? definition.metric : Metric.counter(name);
  return tagMetricWithLabels(metric, labels);
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, any>}
 */
function gaugeMetric(name, labels) {
  const definition = resolveMetricDefinition(name);
  const metric = definition?.type === "gauge" ? definition.metric : Metric.gauge(name);
  return tagMetricWithLabels(metric, labels);
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, any>}
 */
function histogramMetric(name, labels) {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "histogram" ? definition.metric : Metric.histogram(name, { boundaries: durationBuckets });
  return tagMetricWithLabels(metric, labels);
}
/**
 * @param {number | bigint | undefined} value
 * @returns {number}
 */
function metricValueAsNumber(value) {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/**
 * @param {Record<string, string> | undefined} attributes
 * @returns {MetricLabels}
 */
function metricsServiceLabels(attributes) {
  return Object.freeze(
    Object.fromEntries(Object.entries(attributes ?? {}).sort(([left], [right]) => left.localeCompare(right))),
  );
}
/**
 * @param {string} name
 * @param {MetricLabels} labels
 * @returns {string}
 */
function metricsServiceSnapshotKey(name, labels) {
  return `${name}|${JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))}`;
}
/**
 * @returns {PrometheusSample[]}
 */
function metricsServicePrometheusSamples() {
  const samples = [];
  for (const snapshot of Effect.runSync(Metric.snapshot)) {
    const metricState = snapshot.state;
    const name = snapshot.id;
    if (!name) continue;
    const labels = metricsServiceLabels(snapshot.attributes);
    if (snapshot.type === "Counter") {
      samples.push({
        name,
        type: "counter",
        labels,
        value: metricValueAsNumber(metricState.count),
      });
      continue;
    }
    if (snapshot.type === "Gauge") {
      samples.push({
        name,
        type: "gauge",
        labels,
        value: metricValueAsNumber(metricState.value),
      });
      continue;
    }
    if (snapshot.type === "Histogram") {
      samples.push({
        name,
        type: "histogram",
        labels,
        buckets: new Map([...metricState.buckets].map(([boundary, count]) => [boundary, metricValueAsNumber(count)])),
        sum: metricValueAsNumber(metricState.sum),
        count: metricValueAsNumber(metricState.count),
      });
    }
  }
  return samples;
}
/**
 * @returns {MetricsSnapshot}
 */
function metricsServiceSnapshot() {
  const result = new Map();
  for (const sample of metricsServicePrometheusSamples()) {
    const key = metricsServiceSnapshotKey(sample.name, sample.labels);
    if (sample.type === "histogram") {
      result.set(key, {
        type: "histogram",
        sum: sample.sum ?? 0,
        count: sample.count ?? 0,
        labels: sample.labels,
        buckets: new Map(sample.buckets ?? []),
      });
      continue;
    }
    result.set(key, {
      type: sample.type,
      value: sample.value ?? 0,
      labels: sample.labels,
    });
  }
  return result;
}
/** @type {MetricsServiceShape} */
export const metricsServiceAdapter = {
  increment: (name, labels) => {
    const metric = counterOrGaugeMetric(name, labels);
    return resolveMetricDefinition(name)?.type === "gauge" ? incrementGauge(metric, 1) : Metric.update(metric, 1);
  },
  incrementBy: (name, value, labels) => {
    const metric = counterOrGaugeMetric(name, labels);
    return resolveMetricDefinition(name)?.type === "gauge"
      ? incrementGauge(metric, value)
      : Metric.update(metric, value);
  },
  gauge: (name, value, labels) => Metric.update(gaugeMetric(name, labels), value),
  histogram: (name, value, labels) => Metric.update(histogramMetric(name, labels), value),
  recordEvent: (event) => trackEvent(event),
  updateProcessMetrics: () => updateProcessMetrics(),
  updateAsyncExternalWaitPending: (kind, delta) => updateAsyncExternalWaitPending(kind, delta),
  renderPrometheus: () => Effect.sync(() => renderPrometheusSamples(metricsServicePrometheusSamples())),
  snapshot: () => Effect.sync(metricsServiceSnapshot),
};
