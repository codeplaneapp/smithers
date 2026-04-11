import type { AlertSeverity } from "./AlertSeverity.ts";
import type { AlertStatus } from "./AlertStatus.ts";

export type AlertRow = {
  readonly alertId: string;
  readonly runId?: string | null;
  readonly policyName: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly firedAtMs: number;
  readonly resolvedAtMs?: number | null;
  readonly acknowledgedAtMs?: number | null;
  readonly message: string;
  readonly detailsJson?: string | null;
  readonly fingerprint?: string | null;
  readonly nodeId?: string | null;
  readonly iteration?: number | null;
  readonly owner?: string | null;
  readonly runbook?: string | null;
  readonly labelsJson?: string | null;
  readonly reactionJson?: string | null;
  readonly sourceEventType?: string | null;
  readonly firstFiredAtMs?: number | null;
  readonly lastFiredAtMs?: number | null;
  readonly occurrenceCount?: number;
  readonly silencedUntilMs?: number | null;
  readonly acknowledgedBy?: string | null;
  readonly resolvedBy?: string | null;
};
