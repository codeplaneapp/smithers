/**
 * Render a `MetricsRegistry` as the Prometheus text exposition format
 * documented at https://prometheus.io/docs/instrumenting/exposition_formats/.
 *
 * Only the bits we actually use are implemented (counter, gauge, histogram).
 * Output is deterministic — labels are sorted, series are sorted by their
 * serialized key — so the snapshot is easy to diff in tests and dashboards.
 */

import {
  Counter,
  Gauge,
  Histogram,
  type MetricsRegistry,
  type LabelSet,
} from "./metrics";

function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: LabelSet, extra?: Record<string, string>): string {
  const merged: Array<[string, string]> = [];
  for (const key of Object.keys(labels).sort()) {
    merged.push([key, labels[key]]);
  }
  if (extra) {
    for (const key of Object.keys(extra).sort()) {
      merged.push([key, extra[key]]);
    }
  }
  if (merged.length === 0) return "";
  const inner = merged
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
  return `{${inner}}`;
}

function renderCounter(metric: Counter): string {
  const lines = [
    `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
    `# TYPE ${metric.name} counter`,
  ];
  const entries = [...metric.entries()].sort((a, b) =>
    renderLabels(a.labels).localeCompare(renderLabels(b.labels)),
  );
  for (const entry of entries) {
    lines.push(`${metric.name}${renderLabels(entry.labels)} ${entry.value}`);
  }
  return lines.join("\n");
}

function renderGauge(metric: Gauge): string {
  const lines = [
    `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
    `# TYPE ${metric.name} gauge`,
  ];
  const entries = [...metric.entries()].sort((a, b) =>
    renderLabels(a.labels).localeCompare(renderLabels(b.labels)),
  );
  for (const entry of entries) {
    lines.push(`${metric.name}${renderLabels(entry.labels)} ${entry.value}`);
  }
  return lines.join("\n");
}

function renderHistogram(metric: Histogram): string {
  const lines = [
    `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
    `# TYPE ${metric.name} histogram`,
  ];
  const snapshots = [...metric.snapshots()].sort((a, b) =>
    renderLabels(a.labels).localeCompare(renderLabels(b.labels)),
  );
  for (const snapshot of snapshots) {
    for (const bucket of snapshot.buckets) {
      lines.push(
        `${metric.name}_bucket${renderLabels(snapshot.labels, {
          le: String(bucket.upperBound),
        })} ${bucket.count}`,
      );
    }
    lines.push(
      `${metric.name}_bucket${renderLabels(snapshot.labels, {
        le: "+Inf",
      })} ${snapshot.count}`,
    );
    lines.push(`${metric.name}_sum${renderLabels(snapshot.labels)} ${snapshot.sum}`);
    lines.push(`${metric.name}_count${renderLabels(snapshot.labels)} ${snapshot.count}`);
  }
  return lines.join("\n");
}

export function renderPrometheus(registry: MetricsRegistry): string {
  const parts: string[] = [];
  for (const metric of [...registry.all()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (metric instanceof Counter) parts.push(renderCounter(metric));
    else if (metric instanceof Gauge) parts.push(renderGauge(metric));
    else if (metric instanceof Histogram) parts.push(renderHistogram(metric));
  }
  return `${parts.join("\n")}\n`;
}
