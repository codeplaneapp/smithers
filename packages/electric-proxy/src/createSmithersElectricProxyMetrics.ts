export type SmithersElectricProxyMetricSnapshot = {
  shapeOpens: number;
  shapeOpenRejected: number;
  activeShapes: number;
  replayGaps: number;
  largeFrames: number;
  forwardedBytes: number;
  lastSyncLagMs: number | null;
};

export type SmithersElectricProxyMetrics = {
  snapshot(): SmithersElectricProxyMetricSnapshot;
  incShapeOpen(): void;
  incShapeOpenRejected(): void;
  incReplayGap(): void;
  incLargeFrame(): void;
  addForwardedBytes(bytes: number): void;
  setActiveShapes(count: number): void;
  observeSyncLag(ms: number): void;
  renderPrometheus(): string;
};

export function createSmithersElectricProxyMetrics(): SmithersElectricProxyMetrics {
  const state: SmithersElectricProxyMetricSnapshot = {
    shapeOpens: 0,
    shapeOpenRejected: 0,
    activeShapes: 0,
    replayGaps: 0,
    largeFrames: 0,
    forwardedBytes: 0,
    lastSyncLagMs: null,
  };

  return {
    snapshot: () => ({ ...state }),
    incShapeOpen: () => {
      state.shapeOpens += 1;
    },
    incShapeOpenRejected: () => {
      state.shapeOpenRejected += 1;
    },
    incReplayGap: () => {
      state.replayGaps += 1;
    },
    incLargeFrame: () => {
      state.largeFrames += 1;
    },
    addForwardedBytes: (bytes) => {
      state.forwardedBytes += Math.max(0, Math.floor(bytes));
    },
    setActiveShapes: (count) => {
      state.activeShapes = Math.max(0, Math.floor(count));
    },
    observeSyncLag: (ms) => {
      if (Number.isFinite(ms) && ms >= 0) state.lastSyncLagMs = Math.floor(ms);
    },
    renderPrometheus: () => [
      "# HELP smithers_electric_shape_opens_total Electric shape opens accepted by the Smithers proxy.",
      "# TYPE smithers_electric_shape_opens_total counter",
      `smithers_electric_shape_opens_total ${state.shapeOpens}`,
      "# HELP smithers_electric_shape_open_rejected_total Electric shape opens rejected by auth, scope, or rate limits.",
      "# TYPE smithers_electric_shape_open_rejected_total counter",
      `smithers_electric_shape_open_rejected_total ${state.shapeOpenRejected}`,
      "# HELP smithers_electric_active_shapes Active Electric shape streams through this proxy process.",
      "# TYPE smithers_electric_active_shapes gauge",
      `smithers_electric_active_shapes ${state.activeShapes}`,
      "# HELP smithers_electric_replay_gaps_total Electric replay gaps observed by the proxy.",
      "# TYPE smithers_electric_replay_gaps_total counter",
      `smithers_electric_replay_gaps_total ${state.replayGaps}`,
      "# HELP smithers_electric_large_frames_total Electric frames rejected for exceeding the proxy frame bound.",
      "# TYPE smithers_electric_large_frames_total counter",
      `smithers_electric_large_frames_total ${state.largeFrames}`,
      "# HELP smithers_electric_forwarded_bytes_total Response bytes forwarded through the Electric proxy.",
      "# TYPE smithers_electric_forwarded_bytes_total counter",
      `smithers_electric_forwarded_bytes_total ${state.forwardedBytes}`,
      "# HELP smithers_electric_sync_lag_ms Last observed Electric sync lag in milliseconds.",
      "# TYPE smithers_electric_sync_lag_ms gauge",
      `smithers_electric_sync_lag_ms ${state.lastSyncLagMs ?? 0}`,
      "",
    ].join("\n"),
  };
}
