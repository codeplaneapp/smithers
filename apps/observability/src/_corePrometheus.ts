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
export declare function toPrometheusMetricName(name: string): string;
export declare function renderPrometheusSamples(samples: readonly PrometheusSample[]): string;
