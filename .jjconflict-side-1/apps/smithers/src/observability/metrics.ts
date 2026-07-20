/**
 * In-process metrics registry for the Smithers UI worker + browser app.
 *
 * Cheap, dependency-free, and safe to import in both the Cloudflare Worker
 * entry (`src/worker.ts`) and the React app (`src/main.tsx`). The two run in
 * separate JS realms, so each gets its own `defaultRegistry` instance.
 *
 * The Worker scrape at `GET /metrics` exposes the *Worker's* instance — the
 * browser-side metrics that gateway-client wraps record into the *browser*
 * instance and stay browser-local (they show up in the in-page dev panel /
 * future debug surface; they are not federated to Prometheus). The spec at
 * `.smithers/specs/smithers-ui-observability.md` documents which metrics live
 * in which realm.
 *
 * Cardinality safeguard: each metric carries an `allowedLabels` allow-list and
 * a `maxSeries` cap (default 256). A label outside the allow-list is dropped at
 * record time; an unknown label *value* still creates a series, but once the
 * cap is reached new values fall back to the literal token `"__overflow__"`.
 *
 * `allowedLabels: []` is treated as "this metric carries no labels" — a stray
 * label is dropped just like an unknown label on a non-empty allow-list. The
 * old "empty array = filter disabled" behavior was surprising and let a future
 * caller accidentally explode cardinality.
 */

export type LabelSet = Readonly<Record<string, string>>;

/** Common config every metric accepts. */
export type MetricConfig = {
  /** Metric name, e.g. `smithers_ui_worker_proxy_total`. */
  name: string;
  /** Help line emitted alongside the Prometheus output. */
  help: string;
  /**
   * Labels this metric is allowed to carry. Any other label name passed at
   * record time is dropped silently — both to keep cardinality bounded and to
   * avoid accidental PII leaking through ad-hoc labels.
   *
   * Pass `undefined` to disable filtering; pass `[]` to enforce zero labels.
   */
  allowedLabels?: ReadonlyArray<string>;
  /**
   * Hard cap on the number of distinct label-tuples a single metric may track.
   * Defaults to 256. After this is reached, new tuples collapse to the
   * single overflow series, which is itself counted and exported.
   */
  maxSeries?: number;
};

const DEFAULT_MAX_SERIES = 256;
const OVERFLOW_TOKEN = "__overflow__";

/** Default histogram buckets in milliseconds — covers fast RPC to slow polls. */
export const DEFAULT_MS_BUCKETS: ReadonlyArray<number> = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];

/** Default histogram buckets in bytes — covers tiny RPC frames to large payloads. */
export const DEFAULT_BYTE_BUCKETS: ReadonlyArray<number> = [
  256, 1024, 4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024,
  4 * 1024 * 1024,
];

function sortedLabelKeys(labels: LabelSet): string[] {
  return Object.keys(labels).sort();
}

/** Stable string key for a tuple of label values. */
function seriesKey(labels: LabelSet): string {
  const keys = sortedLabelKeys(labels);
  return keys.map((key) => `${key}=${labels[key]}`).join(",");
}

/**
 * `undefined` → no filtering. `[]` → enforce empty (drop everything). Otherwise
 * → enforce membership.
 */
function asAllowSet(
  allowed: ReadonlyArray<string> | undefined,
): Set<string> | null {
  return allowed ? new Set(allowed) : null;
}

class BaseMetric {
  readonly name: string;
  readonly help: string;
  readonly maxSeries: number;
  protected readonly allowedLabels: Set<string> | null;
  protected overflowed = false;

  constructor(config: MetricConfig) {
    this.name = config.name;
    this.help = config.help;
    this.maxSeries = config.maxSeries ?? DEFAULT_MAX_SERIES;
    this.allowedLabels = asAllowSet(config.allowedLabels);
  }

  /**
   * Filter a caller-supplied label set down to the configured allow-list and
   * coerce all values to strings. Foreign labels are silently dropped.
   */
  protected normalizeLabels(labels: LabelSet | undefined): LabelSet {
    if (!labels) return Object.freeze({});
    const out: Record<string, string> = {};
    for (const key of Object.keys(labels)) {
      if (this.allowedLabels && !this.allowedLabels.has(key)) continue;
      out[key] = String(labels[key]);
    }
    return Object.freeze(out);
  }

  /** True once the cap was hit at least once. Exposed for tests/dashboards. */
  hasOverflowed(): boolean {
    return this.overflowed;
  }
}

/** A monotonic counter (delta tracker). Reset only via `reset()`. */
export class Counter extends BaseMetric {
  private readonly values = new Map<string, { labels: LabelSet; value: number }>();

  inc(labels?: LabelSet, by = 1): void {
    if (!Number.isFinite(by) || by < 0) return;
    const normalized = this.normalizeLabels(labels);
    const key = this.keyFor(normalized);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    if (this.values.size >= this.maxSeries) {
      this.overflowed = true;
      const overflowLabels = this.overflowLabels(normalized);
      const overflowKey = seriesKey(overflowLabels);
      const overflow = this.values.get(overflowKey);
      if (overflow) {
        overflow.value += by;
        return;
      }
      this.values.set(overflowKey, { labels: overflowLabels, value: by });
      return;
    }
    this.values.set(key, { labels: normalized, value: by });
  }

  get(labels?: LabelSet): number {
    const normalized = this.normalizeLabels(labels);
    const entry = this.values.get(seriesKey(normalized));
    return entry?.value ?? 0;
  }

  entries(): ReadonlyArray<{ labels: LabelSet; value: number }> {
    return Array.from(this.values.values());
  }

  reset(): void {
    this.values.clear();
    this.overflowed = false;
  }

  private keyFor(labels: LabelSet): string {
    return seriesKey(labels);
  }

  private overflowLabels(labels: LabelSet): LabelSet {
    const next: Record<string, string> = {};
    for (const key of Object.keys(labels)) {
      next[key] = OVERFLOW_TOKEN;
    }
    return Object.freeze(next);
  }
}

/** A point-in-time gauge. Use for queue depth, connection state, etc. */
export class Gauge extends BaseMetric {
  private readonly values = new Map<string, { labels: LabelSet; value: number }>();

  set(value: number, labels?: LabelSet): void {
    if (!Number.isFinite(value)) return;
    const normalized = this.normalizeLabels(labels);
    const key = seriesKey(normalized);
    if (!this.values.has(key) && this.values.size >= this.maxSeries) {
      this.overflowed = true;
      const overflowLabels = this.overflowLabels(normalized);
      this.values.set(seriesKey(overflowLabels), { labels: overflowLabels, value });
      return;
    }
    this.values.set(key, { labels: normalized, value });
  }

  inc(by = 1, labels?: LabelSet): void {
    const current = this.get(labels);
    this.set(current + by, labels);
  }

  dec(by = 1, labels?: LabelSet): void {
    this.inc(-by, labels);
  }

  get(labels?: LabelSet): number {
    const normalized = this.normalizeLabels(labels);
    const entry = this.values.get(seriesKey(normalized));
    return entry?.value ?? 0;
  }

  entries(): ReadonlyArray<{ labels: LabelSet; value: number }> {
    return Array.from(this.values.values());
  }

  reset(): void {
    this.values.clear();
    this.overflowed = false;
  }

  private overflowLabels(labels: LabelSet): LabelSet {
    const next: Record<string, string> = {};
    for (const key of Object.keys(labels)) {
      next[key] = OVERFLOW_TOKEN;
    }
    return Object.freeze(next);
  }
}

type Bucket = { upperBound: number; count: number };

type HistogramSeries = {
  labels: LabelSet;
  buckets: Bucket[];
  sum: number;
  count: number;
};

/** A Prometheus-compatible histogram with explicit buckets. */
export class Histogram extends BaseMetric {
  private readonly series = new Map<string, HistogramSeries>();
  private readonly bucketBounds: ReadonlyArray<number>;

  constructor(config: MetricConfig & { buckets?: ReadonlyArray<number> }) {
    super(config);
    const buckets = (config.buckets ?? DEFAULT_MS_BUCKETS).slice().sort((a, b) => a - b);
    this.bucketBounds = buckets;
  }

  observe(value: number, labels?: LabelSet): void {
    if (!Number.isFinite(value) || value < 0) return;
    const normalized = this.normalizeLabels(labels);
    const key = seriesKey(normalized);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= this.maxSeries) {
        this.overflowed = true;
        const overflowLabels = this.overflowLabels(normalized);
        const overflowKey = seriesKey(overflowLabels);
        entry = this.series.get(overflowKey) ?? this.createSeries(overflowLabels);
        this.series.set(overflowKey, entry);
      } else {
        entry = this.createSeries(normalized);
        this.series.set(key, entry);
      }
    }
    entry.sum += value;
    entry.count += 1;
    for (const bucket of entry.buckets) {
      if (value <= bucket.upperBound) {
        bucket.count += 1;
      }
    }
  }

  /** Snapshot for the exposition layer. */
  snapshots(): ReadonlyArray<HistogramSeries> {
    return Array.from(this.series.values());
  }

  buckets(): ReadonlyArray<number> {
    return this.bucketBounds;
  }

  reset(): void {
    this.series.clear();
    this.overflowed = false;
  }

  private createSeries(labels: LabelSet): HistogramSeries {
    return {
      labels,
      buckets: this.bucketBounds.map((upperBound) => ({ upperBound, count: 0 })),
      sum: 0,
      count: 0,
    };
  }

  private overflowLabels(labels: LabelSet): LabelSet {
    const next: Record<string, string> = {};
    for (const key of Object.keys(labels)) {
      next[key] = OVERFLOW_TOKEN;
    }
    return Object.freeze(next);
  }
}

export type AnyMetric = Counter | Gauge | Histogram;

/**
 * A registry holds every metric the app wants exported. Metrics are
 * idempotently registered by name so that hot-reload in dev does not produce
 * duplicate counters.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, AnyMetric>();

  counter(config: MetricConfig): Counter {
    const existing = this.metrics.get(config.name);
    if (existing instanceof Counter) return existing;
    if (existing) {
      throw new Error(
        `Metric ${config.name} already registered as a different kind`,
      );
    }
    const counter = new Counter(config);
    this.metrics.set(config.name, counter);
    return counter;
  }

  gauge(config: MetricConfig): Gauge {
    const existing = this.metrics.get(config.name);
    if (existing instanceof Gauge) return existing;
    if (existing) {
      throw new Error(
        `Metric ${config.name} already registered as a different kind`,
      );
    }
    const gauge = new Gauge(config);
    this.metrics.set(config.name, gauge);
    return gauge;
  }

  histogram(config: MetricConfig & { buckets?: ReadonlyArray<number> }): Histogram {
    const existing = this.metrics.get(config.name);
    if (existing instanceof Histogram) return existing;
    if (existing) {
      throw new Error(
        `Metric ${config.name} already registered as a different kind`,
      );
    }
    const histogram = new Histogram(config);
    this.metrics.set(config.name, histogram);
    return histogram;
  }

  get(name: string): AnyMetric | undefined {
    return this.metrics.get(name);
  }

  all(): ReadonlyArray<AnyMetric> {
    return Array.from(this.metrics.values());
  }

  reset(): void {
    for (const metric of this.metrics.values()) {
      if (metric instanceof Counter) metric.reset();
      if (metric instanceof Gauge) metric.reset();
      if (metric instanceof Histogram) metric.reset();
    }
  }
}

/**
 * Worker-process registry: scraped by `GET /metrics`. Holds the proxy counters
 * and the logger-drop counter. Anything registered here MUST be safe to expose
 * to a Prometheus scrape — no PII, no transient browser state.
 */
export const workerRegistry = new MetricsRegistry();

/**
 * Browser-process registry: not federated. Holds the gateway-client + stream
 * + surface-refresh metrics so they are available to an in-page debug surface
 * (and would graduate to a beacon shipper without API churn) but stay out of
 * the Worker scrape. Keeping them in a separate registry makes the split
 * explicit instead of relying on "they happen to run in different realms".
 */
export const browserRegistry = new MetricsRegistry();

/**
 * Back-compat alias. Existing call sites that don't yet differentiate get the
 * worker registry; new browser-side metrics should import `browserRegistry`
 * directly so the separation is visible at the registration site.
 */
export const defaultRegistry = workerRegistry;
