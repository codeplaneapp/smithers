import type { AlertSeverity } from "./AlertSeverity";
import type { AlertStatus } from "./AlertStatus";

export type AlertRow = {
  alertId: string;
  runId: string | null;
  policyName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  firedAtMs: number;
  resolvedAtMs: number | null;
  acknowledgedAtMs: number | null;
  message: string;
  detailsJson: string | null;
  fingerprint?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
  owner?: string | null;
  runbook?: string | null;
  labelsJson?: string | null;
  reactionJson?: string | null;
  sourceEventType?: string | null;
  firstFiredAtMs?: number | null;
  lastFiredAtMs?: number | null;
  occurrenceCount?: number;
  silencedUntilMs?: number | null;
  acknowledgedBy?: string | null;
  resolvedBy?: string | null;
};
