import { Effect, Metric, MetricState, Option } from "effect";
import { smithersMetricCatalog, toPrometheusMetricName, updateProcessMetrics, } from "./metrics/index.js";
/** @typedef {import("./SmithersMetricDefinition.ts").SmithersMetricDefinition} SmithersMetricDefinition */

/**
 * @param {string} text
 * @returns {string}
 */
function escapePrometheusText(text) {
    return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/**
 * @param {string} value
 * @returns {string}
 */
function escapePrometheusLabelValue(value) {
    return escapePrometheusText(value).replace(/"/g, '\\"');
}
/**
 * @param {number | bigint} value
 * @returns {string}
 */
function formatPrometheusNumber(value) {
    if (typeof value === "bigint")
        return value.toString();
    if (Number.isNaN(value))
        return "NaN";
    if (value === Number.POSITIVE_INFINITY)
        return "+Inf";
    if (value === Number.NEGATIVE_INFINITY)
        return "-Inf";
    return String(value);
}
/**
 * @param {ReadonlyArray<[string, string]>} labels
 * @returns {string}
 */
function formatPrometheusLabels(labels) {
    if (labels.length === 0)
        return "";
    return `{${labels
        .map(([key, value]) => `${toPrometheusMetricName(key)}="${escapePrometheusLabelValue(value)}"`)
        .join(",")}}`;
}
/**
 * @param {ReadonlyArray<[string, string]>} base
 * @param {ReadonlyArray<[string, string]>} extra
 * @returns {string}
 */
function mergePrometheusLabels(base, extra) {
    const merged = [...base, ...extra].sort(([left], [right]) => left.localeCompare(right));
    return formatPrometheusLabels(merged);
}
/**
 * @param {any} metricKey
 * @returns {ReadonlyArray<[string, string]>}
 */
function metricLabels(metricKey) {
    const tags = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
    return tags
        .map((tag) => [String(tag.key), String(tag.value)])
        .sort(([left], [right]) => left.localeCompare(right));
}
/**
 * @param {any} metricKey
 * @returns {string | undefined}
 */
function metricHelp(metricKey) {
    const description = Option.getOrElse(metricKey?.description, () => "");
    return description.trim() ? description : undefined;
}
/**
 * @param {any} metricState
 * @returns {PrometheusBucket[]}
 */
function histogramBuckets(metricState) {
    const buckets = [];
    if (!metricState?.buckets ||
        typeof metricState.buckets[Symbol.iterator] !== "function") {
        return buckets;
    }
    for (const [boundary, count] of metricState.buckets) {
        buckets.push({ boundary, count });
    }
    return buckets.sort((left, right) => left.boundary - right.boundary);
}
/**
 * @param {SmithersMetricDefinition} definition
 * @returns {string | undefined}
 */
function defaultMetricHelp(definition) {
    return definition.description ?? definition.label;
}
/**
 * @param {SmithersMetricDefinition} definition
 * @returns {string[]}
 */
function defaultPrometheusMetricLines(definition) {
    const labelSets = definition.defaultLabels && definition.defaultLabels.length > 0
        ? definition.defaultLabels.map((labels) => Object.entries(labels))
        : [[]];
    if (definition.type === "histogram") {
        const boundaries = definition.boundaries ?? [];
        return labelSets.flatMap((labelSet) => {
            const baseLabels = labelSet;
            return [
                ...boundaries.map((boundary) => `${definition.prometheusName}_bucket${mergePrometheusLabels(baseLabels, [["le", String(boundary)]])} 0`),
                `${definition.prometheusName}_bucket${mergePrometheusLabels(baseLabels, [["le", "+Inf"]])} 0`,
                `${definition.prometheusName}_sum${formatPrometheusLabels(baseLabels)} 0`,
                `${definition.prometheusName}_count${formatPrometheusLabels(baseLabels)} 0`,
            ];
        });
    }
    return labelSets.map((labelSet) => `${definition.prometheusName}${formatPrometheusLabels(labelSet)} 0`);
}
/**
 * @param {Map<string, PrometheusMetricRecord>} registry
 * @param {string} name
 * @param {PrometheusMetricType} type
 * @param {string | undefined} help
 */
function registerPrometheusMetric(registry, name, type, help) {
    const existing = registry.get(name);
    if (existing) {
        if (!existing.help && help) {
            existing.help = help;
        }
        return existing;
    }
    const created = { type, help, lines: [] };
    registry.set(name, created);
    return created;
}
/**
 * @returns {string}
 */
export function renderPrometheusMetrics() {
    // Snapshot process-level gauges before rendering
    try {
        Effect.runSync(updateProcessMetrics());
    }
    catch { /* non-critical */ }
    const registry = new Map();
    for (const snapshot of Metric.unsafeSnapshot()) {
        const metricKey = snapshot.metricKey;
        const metricState = snapshot.metricState;
        const name = toPrometheusMetricName(String(metricKey.name ?? ""));
        if (!name)
            continue;
        const labels = metricLabels(metricKey);
        const help = metricHelp(metricKey);
        if (MetricState.isCounterState(metricState)) {
            const metric = registerPrometheusMetric(registry, name, "counter", help);
            metric.lines.push(`${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`);
            continue;
        }
        if (MetricState.isGaugeState(metricState)) {
            const metric = registerPrometheusMetric(registry, name, "gauge", help);
            metric.lines.push(`${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.value)}`);
            continue;
        }
        if (MetricState.isHistogramState(metricState)) {
            const metric = registerPrometheusMetric(registry, name, "histogram", help);
            for (const bucket of histogramBuckets(metricState)) {
                metric.lines.push(`${name}_bucket${mergePrometheusLabels(labels, [["le", String(bucket.boundary)]])} ${formatPrometheusNumber(bucket.count)}`);
            }
            metric.lines.push(`${name}_bucket${mergePrometheusLabels(labels, [["le", "+Inf"]])} ${formatPrometheusNumber(metricState.count)}`);
            metric.lines.push(`${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`);
            metric.lines.push(`${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`);
            continue;
        }
        if (MetricState.isFrequencyState(metricState)) {
            const metric = registerPrometheusMetric(registry, name, "counter", help);
            for (const [key, count] of metricState.occurrences) {
                metric.lines.push(`${name}${mergePrometheusLabels(labels, [["key", key]])} ${formatPrometheusNumber(count)}`);
            }
            continue;
        }
        if (MetricState.isSummaryState(metricState)) {
            const metric = registerPrometheusMetric(registry, name, "summary", help);
            metric.lines.push(`${name}${mergePrometheusLabels(labels, [["quantile", "min"]])} ${formatPrometheusNumber(metricState.min)}`);
            for (const [quantile, value] of metricState.quantiles) {
                metric.lines.push(`${name}${mergePrometheusLabels(labels, [["quantile", String(quantile)]])} ${formatPrometheusNumber(Option.getOrElse(value, () => 0))}`);
            }
            metric.lines.push(`${name}${mergePrometheusLabels(labels, [["quantile", "max"]])} ${formatPrometheusNumber(metricState.max)}`);
            metric.lines.push(`${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`);
            metric.lines.push(`${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`);
        }
    }
    for (const definition of smithersMetricCatalog) {
        const metric = registerPrometheusMetric(registry, definition.prometheusName, definition.type, defaultMetricHelp(definition));
        if (metric.lines.length === 0) {
            metric.lines.push(...defaultPrometheusMetricLines(definition));
        }
    }
    const lines = [];
    for (const [name, metric] of [...registry.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (metric.help) {
            lines.push(`# HELP ${name} ${escapePrometheusText(metric.help)}`);
        }
        lines.push(`# TYPE ${name} ${metric.type}`);
        lines.push(...metric.lines);
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
