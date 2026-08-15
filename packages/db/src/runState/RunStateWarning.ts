export type RunStateWarning = {
  kind: "concurrency-ceiling-saturated";
  requestedDemand: number;
  effectiveCap: number;
  remediationCommand: string;
  observedAt: string;
};
