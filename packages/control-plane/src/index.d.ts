import { Database } from 'bun:sqlite';

type ControlPlaneSqlite = Database | {
  exec(sql: string): unknown;
  query(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
};

type ControlPlaneOrg = {
  orgId: string;
  slug: string;
  name: string;
  createdAtMs: number;
};

type ControlPlaneTeam = {
  orgId: string;
  teamId: string;
  slug: string;
  name: string;
  createdAtMs: number;
};

type ControlPlaneProject = {
  orgId: string;
  projectId: string;
  slug: string;
  name: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
};

type ControlPlaneBillingAccount = {
  orgId: string;
  plan: string;
  billingCustomerId: string | null;
  status: string;
  updatedAtMs: number;
};

type ControlPlaneIdentityProvider = {
  orgId: string;
  providerId: string;
  type: string;
  issuer: string;
  ssoUrl: string | null;
  certificateRef: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
};

type ControlPlaneUsageEvent = {
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

type ControlPlaneUsageLimit = {
  orgId: string;
  projectId: string | null;
  metric: string;
  unit: string;
  period: string;
  limitQuantity: number;
  updatedAtMs: number;
};

type ControlPlaneUsageLimitCheck = ControlPlaneUsageLimit & {
  usedQuantity: number;
  remainingQuantity: number;
  exceeded: boolean;
};

type ControlPlaneUsageSummary = {
  orgId: string;
  metric: string;
  unit: string;
  quantity: number;
};

type ControlPlaneSecretRef = {
  orgId: string;
  projectId: string | null;
  name: string;
  provider: string;
  ref: string;
  createdBy: string | null;
  createdAtMs: number;
  rotatedAtMs: number | null;
};

type ControlPlaneAuditEvent = {
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

type ControlPlaneExport = {
  exportedAtMs: number;
  org: ControlPlaneOrg;
  projects: ControlPlaneProject[];
  teams: ControlPlaneTeam[];
  billing: ControlPlaneBillingAccount | null;
  identityProviders: ControlPlaneIdentityProvider[];
  usage: ControlPlaneUsageSummary[];
  usageLimits: ControlPlaneUsageLimit[];
  secretRefs: ControlPlaneSecretRef[];
  auditEvents: ControlPlaneAuditEvent[];
};

declare function ensureControlPlaneTables(sqlite: ControlPlaneSqlite): void;

declare class ControlPlaneStore {
  constructor(sqlite: ControlPlaneSqlite);

  createOrg(input: { orgId?: string; slug: string; name: string; createdAtMs?: number }): ControlPlaneOrg;
  getOrg(orgId: string): ControlPlaneOrg | null;
  createTeam(input: { orgId: string; teamId?: string; slug: string; name: string; createdAtMs?: number }): ControlPlaneTeam;
  addTeamMember(input: { orgId: string; teamId: string; userId: string; role?: string; createdAtMs?: number }): void;
  createProject(input: { orgId: string; projectId?: string; slug: string; name: string; metadata?: Record<string, unknown>; createdAtMs?: number }): ControlPlaneProject;
  addProjectTeam(input: { orgId: string; projectId: string; teamId: string; role?: string; createdAtMs?: number }): void;
  upsertBillingAccount(input: { orgId: string; plan: string; billingCustomerId?: string | null; status?: string; updatedAtMs?: number }): ControlPlaneBillingAccount;
  upsertIdentityProvider(input: { orgId: string; providerId?: string; type: string; issuer: string; ssoUrl?: string | null; certificateRef?: string | null; status?: string; metadata?: Record<string, unknown>; createdAtMs?: number; updatedAtMs?: number }): ControlPlaneIdentityProvider;
  listIdentityProviders(input: { orgId: string; status?: string }): ControlPlaneIdentityProvider[];
  recordUsage(input: { orgId: string; projectId?: string | null; runId?: string | null; metric: string; quantity: number; unit?: string; observedAtMs?: number; metadata?: Record<string, unknown> }): ControlPlaneUsageEvent;
  summarizeUsage(input: { orgId: string; sinceMs?: number; untilMs?: number }): ControlPlaneUsageSummary[];
  setUsageLimit(input: { orgId: string; projectId?: string | null; metric: string; unit?: string; period?: string; limitQuantity: number; updatedAtMs?: number }): ControlPlaneUsageLimit;
  checkUsageLimit(input: { orgId: string; projectId?: string | null; metric: string; unit?: string; period?: string; sinceMs?: number; untilMs?: number }): ControlPlaneUsageLimitCheck | null;
  putSecretRef(input: { orgId: string; projectId?: string | null; name: string; provider: string; ref: string; createdBy?: string | null; createdAtMs?: number; rotatedAtMs?: number | null }): ControlPlaneSecretRef;
  listSecretRefs(input: { orgId: string; projectId?: string | null }): ControlPlaneSecretRef[];
  recordAuditEvent(input: { orgId: string; projectId?: string | null; actorId?: string | null; action: string; targetType: string; targetId?: string | null; occurredAtMs?: number; metadata?: Record<string, unknown> }): ControlPlaneAuditEvent;
  exportOrgAudit(input: { orgId: string; sinceMs?: number; untilMs?: number; exportedAtMs?: number }): ControlPlaneExport;
}

export { type ControlPlaneAuditEvent, type ControlPlaneBillingAccount, type ControlPlaneExport, type ControlPlaneIdentityProvider, type ControlPlaneOrg, type ControlPlaneProject, type ControlPlaneSecretRef, type ControlPlaneSqlite, ControlPlaneStore, type ControlPlaneTeam, type ControlPlaneUsageEvent, type ControlPlaneUsageLimit, type ControlPlaneUsageLimitCheck, type ControlPlaneUsageSummary, ensureControlPlaneTables };
