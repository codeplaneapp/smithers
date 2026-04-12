export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export type PrometheusSample = {
  readonly name: string;
  readonly type: "counter" | "gauge" | "histogram";
  readonly labels: MetricLabels;
  readonly value?: number;
  readonly buckets?: ReadonlyMap<number, number>;
  readonly sum?: number;
  readonly count?: number;
};

export function toPrometheusMetricName(name: string): string {
  const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return escapeText(value).replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "";
  return `{${entries
    .map(
      ([key, value]) =>
        `${toPrometheusMetricName(key)}="${escapeLabelValue(String(value))}"`,
    )
    .join(",")}}`;
}

function mergeLabels(
  labels: MetricLabels,
  extra: MetricLabels,
): MetricLabels {
  return { ...labels, ...extra };
}

export function renderPrometheusSamples(
  samples: readonly PrometheusSample[],
): string {
  const grouped = new Map<
    string,
    { readonly type: PrometheusSample["type"]; readonly lines: string[] }
  >();

  for (const sample of samples) {
    const name = toPrometheusMetricName(sample.name);
    const group =
      grouped.get(name) ??
      (() => {
        const created = { type: sample.type, lines: [] as string[] };
        grouped.set(name, created);
        return created;
      })();

    if (sample.type === "histogram") {
      const buckets = [...(sample.buckets ?? new Map()).entries()].sort(
        ([left], [right]) => left - right,
      );
      for (const [boundary, count] of buckets) {
        group.lines.push(
          `${name}_bucket${formatLabels(mergeLabels(sample.labels, { le: boundary }))} ${formatNumber(count)}`,
        );
      }
      group.lines.push(
        `${name}_bucket${formatLabels(mergeLabels(sample.labels, { le: "+Inf" }))} ${formatNumber(sample.count ?? 0)}`,
      );
      group.lines.push(
        `${name}_sum${formatLabels(sample.labels)} ${formatNumber(sample.sum ?? 0)}`,
      );
      group.lines.push(
        `${name}_count${formatLabels(sample.labels)} ${formatNumber(sample.count ?? 0)}`,
      );
    } else {
      group.lines.push(
        `${name}${formatLabels(sample.labels)} ${formatNumber(sample.value ?? 0)}`,
      );
    }
  }

  const lines: string[] = [];
  for (const [name, group] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`# TYPE ${name} ${group.type}`);
    lines.push(...group.lines.sort());
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
