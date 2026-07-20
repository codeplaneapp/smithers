export type SmithersElectricProxyMetricSnapshot = {
  shapeOpens: number;
  shapeOpenRejected: number;
  activeShapes: number;
  replayGaps: number;
  largeFrames: number;
  forwardedBytes: number;
  upstreamErrors: number;
  lastSyncLagMs: number | null;
};

export type SmithersElectricProxyMetrics = {
  snapshot(): SmithersElectricProxyMetricSnapshot;
  incShapeOpen(): void;
  incShapeOpenRejected(): void;
  incReplayGap(): void;
  incLargeFrame(): void;
  incUpstreamError(): void;
  addForwardedBytes(bytes: number): void;
  setActiveShapes(count: number): void;
  observeSyncLag(ms: number): void;
  renderPrometheus(): string;
};
