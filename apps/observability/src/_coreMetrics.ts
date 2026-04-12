import { Context, Effect, Layer } from "effect";
import { type MetricLabels } from "./_corePrometheus.ts";
import type { SmithersMetricDefinition } from "./SmithersMetricDefinition.ts";
import type { MetricName } from "./MetricName.ts";
export type { MetricName } from "./MetricName.ts";
export type { MetricLabels };
export type { SmithersMetricType } from "./SmithersMetricType.ts";
export type { SmithersMetricUnit } from "./SmithersMetricUnit.ts";
export type { SmithersMetricDefinition } from "./SmithersMetricDefinition.ts";
export declare const smithersMetricCatalog: readonly SmithersMetricDefinition[];
export declare const smithersMetricCatalogByKey: Map<string, SmithersMetricDefinition>;
export declare const smithersMetricCatalogByPrometheusName: Map<string, SmithersMetricDefinition>;
export declare const smithersMetricCatalogByName: Map<string, SmithersMetricDefinition>;
export declare const smithersMetrics: Readonly<Record<string, string>>;
export type SmithersMetricEvent = {
    readonly type: string;
    readonly [key: string]: unknown;
};
type CounterEntry = {
    readonly type: "counter";
    value: number;
    readonly labels: MetricLabels;
};
type GaugeEntry = {
    readonly type: "gauge";
    value: number;
    readonly labels: MetricLabels;
};
type HistogramEntry = {
    readonly type: "histogram";
    sum: number;
    count: number;
    readonly labels: MetricLabels;
    readonly buckets: Map<number, number>;
};
type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;
export type MetricsSnapshot = ReadonlyMap<string, MetricEntry>;
export type MetricsServiceShape = {
    readonly increment: (name: MetricName, labels?: MetricLabels) => Effect.Effect<void>;
    readonly incrementBy: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly gauge: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly histogram: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
    readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
    readonly updateProcessMetrics: () => Effect.Effect<void>;
    readonly updateAsyncExternalWaitPending: (kind: "approval" | "event", delta: number) => Effect.Effect<void>;
    readonly renderPrometheus: () => Effect.Effect<string>;
    readonly snapshot: () => Effect.Effect<MetricsSnapshot>;
};
declare const MetricsService_base: Context.TagClass<MetricsService, "MetricsService", MetricsServiceShape>;
export declare class MetricsService extends MetricsService_base {
}
export declare function makeInMemoryMetricsService(): Context.Tag.Service<MetricsService>;
export declare const MetricsServiceLive: Layer.Layer<MetricsService, never, never>;
export declare const MetricsServiceNoop: Layer.Layer<MetricsService, never, never>;
