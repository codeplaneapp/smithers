import type { Database } from "bun:sqlite";

export type ControlPlaneSqlite = Database | {
  exec(sql: string): unknown;
  query(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
};

export type ControlPlaneOrg = {
  orgId: string;
  slug: string;
  name: string;
  createdAtMs: number;
};

export type ControlPlaneTeam = {
  orgId: string;
  teamId: string;
  slug: string;
  name: string;
  createdAtMs: number;
};

export type ControlPlaneProject = {
  orgId: string;
  projectId: string;
  slug: string;
  name: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
};

export type ControlPlaneBillingAccount = {
  orgId: string;
  plan: string;
  billingCustomerId: string | null;
  status: string;
  updatedAtMs: number;
};

export type ControlPlaneUsageEvent = {
  id: number;
  orgId: string;
  projectId: string | null;
  runId: string | null;
  metric: string;
  quantity: number;
  unit: string;
  observedAtMs: number;
  metadata: Record<string, unknown>;
};

export type ControlPlaneUsageSummary = {
  orgId: string;
  metric: string;
  unit: string;
  quantity: number;
};

export type ControlPlaneSecretRef = {
  orgId: string;
  projectId: string | null;
  name: string;
  provider: string;
  ref: string;
  createdBy: string | null;
  createdAtMs: number;
  rotatedAtMs: number | null;
};

export type ControlPlaneAuditEvent = {
  id: number;
  orgId: string;
  projectId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  occurredAtMs: number;
  metadata: Record<string, unknown>;
};

export type ControlPlaneExport = {
  exportedAtMs: number;
  org: ControlPlaneOrg;
  projects: ControlPlaneProject[];
  teams: ControlPlaneTeam[];
  billing: ControlPlaneBillingAccount | null;
  usage: ControlPlaneUsageSummary[];
  secretRefs: ControlPlaneSecretRef[];
  auditEvents: ControlPlaneAuditEvent[];
};

export function ensureControlPlaneTables(sqlite: ControlPlaneSqlite): void;

export class ControlPlaneStore {
  constructor(sqlite: ControlPlaneSqlite);

  createOrg(input: { orgId?: string; slug: string; name: string; createdAtMs?: number }): ControlPlaneOrg;
  getOrg(orgId: string): ControlPlaneOrg | null;
  createTeam(input: { orgId: string; teamId?: string; slug: string; name: string; createdAtMs?: number }): ControlPlaneTeam;
  addTeamMember(input: { orgId: string; teamId: string; userId: string; role?: string; createdAtMs?: number }): void;
  createProject(input: { orgId: string; projectId?: string; slug: string; name: string; metadata?: Record<string, unknown>; createdAtMs?: number }): ControlPlaneProject;
  addProjectTeam(input: { orgId: string; projectId: string; teamId: string; role?: string; createdAtMs?: number }): void;
  upsertBillingAccount(input: { orgId: string; plan: string; billingCustomerId?: string | null; status?: string; updatedAtMs?: number }): ControlPlaneBillingAccount;
  recordUsage(input: { orgId: string; projectId?: string | null; runId?: string | null; metric: string; quantity: number; unit?: string; observedAtMs?: number; metadata?: Record<string, unknown> }): ControlPlaneUsageEvent;
  summarizeUsage(input: { orgId: string; sinceMs?: number; untilMs?: number }): ControlPlaneUsageSummary[];
  putSecretRef(input: { orgId: string; projectId?: string | null; name: string; provider: string; ref: string; createdBy?: string | null; createdAtMs?: number; rotatedAtMs?: number | null }): ControlPlaneSecretRef;
  listSecretRefs(input: { orgId: string; projectId?: string | null }): ControlPlaneSecretRef[];
  recordAuditEvent(input: { orgId: string; projectId?: string | null; actorId?: string | null; action: string; targetType: string; targetId?: string | null; occurredAtMs?: number; metadata?: Record<string, unknown> }): ControlPlaneAuditEvent;
  exportOrgAudit(input: { orgId: string; sinceMs?: number; untilMs?: number; exportedAtMs?: number }): ControlPlaneExport;
}
