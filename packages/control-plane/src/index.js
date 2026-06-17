import { randomUUID } from "node:crypto";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * @typedef {import("./index.d.ts").ControlPlaneSqlite} ControlPlaneSqlite
 * @typedef {import("./index.d.ts").ControlPlaneOrg} ControlPlaneOrg
 * @typedef {import("./index.d.ts").ControlPlaneTeam} ControlPlaneTeam
 * @typedef {import("./index.d.ts").ControlPlaneProject} ControlPlaneProject
 * @typedef {import("./index.d.ts").ControlPlaneBillingAccount} ControlPlaneBillingAccount
 * @typedef {import("./index.d.ts").ControlPlaneIdentityProvider} ControlPlaneIdentityProvider
 * @typedef {import("./index.d.ts").ControlPlaneUsageEvent} ControlPlaneUsageEvent
 * @typedef {import("./index.d.ts").ControlPlaneUsageLimit} ControlPlaneUsageLimit
 * @typedef {import("./index.d.ts").ControlPlaneUsageLimitCheck} ControlPlaneUsageLimitCheck
 * @typedef {import("./index.d.ts").ControlPlaneUsageSummary} ControlPlaneUsageSummary
 * @typedef {import("./index.d.ts").ControlPlaneSecretRef} ControlPlaneSecretRef
 * @typedef {import("./index.d.ts").ControlPlaneAuditEvent} ControlPlaneAuditEvent
 * @typedef {import("./index.d.ts").ControlPlaneExport} ControlPlaneExport
 */

const SLUG_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,62}[a-z0-9])$/;
const ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const USAGE_LIMIT_PERIODS = new Map([
    ["daily", 24 * 60 * 60 * 1000],
    ["weekly", 7 * 24 * 60 * 60 * 1000],
    ["monthly", 30 * 24 * 60 * 60 * 1000],
]);

/**
 * @param {ControlPlaneSqlite} sqlite
 */
export function ensureControlPlaneTables(sqlite) {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(`
CREATE TABLE IF NOT EXISTS _smithers_cp_orgs (
  org_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS _smithers_cp_teams (
  org_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, team_id),
  UNIQUE (org_id, slug),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_team_members (
  org_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, team_id, user_id),
  FOREIGN KEY (org_id, team_id) REFERENCES _smithers_cp_teams(org_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_projects (
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id),
  UNIQUE (org_id, slug),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_project_teams (
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, team_id),
  FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, team_id) REFERENCES _smithers_cp_teams(org_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_billing_accounts (
  org_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  billing_customer_id TEXT,
  status TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_identity_providers (
  org_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  type TEXT NOT NULL,
  issuer TEXT NOT NULL,
  sso_url TEXT,
  certificate_ref TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, provider_id),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS _smithers_cp_idp_org_status_idx
  ON _smithers_cp_identity_providers(org_id, status);

CREATE TABLE IF NOT EXISTS _smithers_cp_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  metric TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS _smithers_cp_usage_org_time_idx
  ON _smithers_cp_usage_events(org_id, observed_at_ms);

CREATE TABLE IF NOT EXISTS _smithers_cp_usage_limits (
  org_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  project_id TEXT,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  period TEXT NOT NULL,
  limit_quantity REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_key, metric, unit, period),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS _smithers_cp_usage_limits_org_idx
  ON _smithers_cp_usage_limits(org_id, metric, unit, period);

CREATE TABLE IF NOT EXISTS _smithers_cp_secret_refs (
  org_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_by TEXT,
  created_at_ms INTEGER NOT NULL,
  rotated_at_ms INTEGER,
  PRIMARY KEY (org_id, project_key, name),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _smithers_cp_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  occurred_at_ms INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS _smithers_cp_audit_org_time_idx
  ON _smithers_cp_audit_events(org_id, occurred_at_ms);
`);
    migrateSecretRefsProjectKey(sqlite);
}

/**
 * @param {ControlPlaneSqlite} sqlite
 */
function migrateSecretRefsProjectKey(sqlite) {
    const columns = sqlite.query("PRAGMA table_info(_smithers_cp_secret_refs)").all();
    if (columns.some((column) => String(column.name) === "project_key")) {
        return;
    }
    sqlite.exec(`
ALTER TABLE _smithers_cp_secret_refs RENAME TO _smithers_cp_secret_refs_legacy;

CREATE TABLE _smithers_cp_secret_refs (
  org_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_by TEXT,
  created_at_ms INTEGER NOT NULL,
  rotated_at_ms INTEGER,
  PRIMARY KEY (org_id, project_key, name),
  FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs(org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE
);

INSERT OR REPLACE INTO _smithers_cp_secret_refs (
  org_id, project_key, project_id, name, provider, ref, created_by, created_at_ms, rotated_at_ms
)
SELECT
  org_id,
  COALESCE(project_id, '__org__') AS project_key,
  project_id,
  name,
  provider,
  ref,
  created_by,
  created_at_ms,
  rotated_at_ms
FROM _smithers_cp_secret_refs_legacy
ORDER BY created_at_ms;

DROP TABLE _smithers_cp_secret_refs_legacy;
`);
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function nonEmptyString(field, value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new SmithersError("INVALID_INPUT", `${field} is required.`);
    }
    return value.trim();
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function optionalId(field, value) {
    const id = typeof value === "string" && value.trim() ? value.trim() : randomUUID();
    if (!ID_RE.test(id)) {
        throw new SmithersError("INVALID_INPUT", `${field} must match ${ID_RE}.`, { field });
    }
    return id;
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function requiredId(field, value) {
    const id = nonEmptyString(field, value);
    if (!ID_RE.test(id)) {
        throw new SmithersError("INVALID_INPUT", `${field} must match ${ID_RE}.`, { field });
    }
    return id;
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function slug(field, value) {
    const out = nonEmptyString(field, value);
    if (!SLUG_RE.test(out)) {
        throw new SmithersError("INVALID_INPUT", `${field} must be a lowercase slug.`, { field });
    }
    return out;
}

/**
 * @param {unknown} value
 */
function jsonObject(value) {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SmithersError("INVALID_INPUT", "metadata must be a JSON object.");
    }
    return value;
}

/**
 * @param {unknown} value
 */
function parseJsonObject(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        console.warn("control-plane: ignoring malformed metadata_json.", {
            error: error instanceof Error ? error.message : String(error),
        });
        return {};
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * @param {unknown} value
 */
function timestamp(value) {
    const n = value === undefined ? Date.now() : Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new SmithersError("INVALID_INPUT", "timestamp must be a non-negative finite number.");
    }
    return Math.floor(n);
}

/**
 * @param {unknown} value
 */
function quantity(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new SmithersError("INVALID_INPUT", "quantity must be a non-negative finite number.");
    }
    return n;
}

/**
 * @param {unknown} value
 */
function usageLimitPeriod(value) {
    const period = nonEmptyString("period", value);
    if (!USAGE_LIMIT_PERIODS.has(period)) {
        throw new SmithersError("INVALID_INPUT", "period must be one of: daily, weekly, monthly.", { period });
    }
    return period;
}

/**
 * @param {string | null} projectId
 */
function projectKey(projectId) {
    return projectId ?? "__org__";
}

/**
 * @param {unknown} error
 * @param {string} constraint
 */
function isUniqueConstraintError(error, constraint) {
    return error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${constraint}`);
}

/**
 * @param {unknown} error
 * @param {{ entity: "org" | "team" | "project"; slug: string; orgId?: string }} input
 */
function throwDuplicateSlugError(error, input) {
    const details = {
        kind: `control-plane.${input.entity}`,
        id: input.slug,
        slug: input.slug,
        ...(input.orgId ? { orgId: input.orgId } : {}),
    };
    throw new SmithersError(
        "DUPLICATE_ID",
        `Duplicate control-plane ${input.entity} slug: ${input.slug}`,
        details,
        { cause: error },
    );
}

/**
 * @param {unknown} error
 * @param {string} constraint
 */
function isUniqueConstraintError(error, constraint) {
    return error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${constraint}`);
}

/**
 * @param {unknown} error
 * @param {{ entity: "org" | "team" | "project"; slug: string; orgId?: string }} input
 */
function throwDuplicateSlugError(error, input) {
    const details = {
        kind: `control-plane.${input.entity}`,
        id: input.slug,
        slug: input.slug,
        ...(input.orgId ? { orgId: input.orgId } : {}),
    };
    throw new SmithersError(
        "DUPLICATE_ID",
        `Duplicate control-plane ${input.entity} slug: ${input.slug}`,
        details,
        { cause: error },
    );
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneOrg}
 */
function orgRow(row) {
    return {
        orgId: String(row.orgId),
        slug: String(row.slug),
        name: String(row.name),
        createdAtMs: Number(row.createdAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneTeam}
 */
function teamRow(row) {
    return {
        orgId: String(row.orgId),
        teamId: String(row.teamId),
        slug: String(row.slug),
        name: String(row.name),
        createdAtMs: Number(row.createdAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneProject}
 */
function projectRow(row) {
    return {
        orgId: String(row.orgId),
        projectId: String(row.projectId),
        slug: String(row.slug),
        name: String(row.name),
        metadata: parseJsonObject(row.metadataJson),
        createdAtMs: Number(row.createdAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneBillingAccount}
 */
function billingRow(row) {
    return {
        orgId: String(row.orgId),
        plan: String(row.plan),
        billingCustomerId: row.billingCustomerId === null ? null : String(row.billingCustomerId),
        status: String(row.status),
        updatedAtMs: Number(row.updatedAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneIdentityProvider}
 */
function identityProviderRow(row) {
    return {
        orgId: String(row.orgId),
        providerId: String(row.providerId),
        type: String(row.type),
        issuer: String(row.issuer),
        ssoUrl: row.ssoUrl === null ? null : String(row.ssoUrl),
        certificateRef: row.certificateRef === null ? null : String(row.certificateRef),
        status: String(row.status),
        metadata: parseJsonObject(row.metadataJson),
        createdAtMs: Number(row.createdAtMs),
        updatedAtMs: Number(row.updatedAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneUsageEvent}
 */
function usageRow(row) {
    return {
        id: Number(row.id),
        orgId: String(row.orgId),
        projectId: row.projectId === null ? null : String(row.projectId),
        runId: row.runId === null ? null : String(row.runId),
        metric: String(row.metric),
        quantity: Number(row.quantity),
        unit: String(row.unit),
        observedAtMs: Number(row.observedAtMs),
        metadata: parseJsonObject(row.metadataJson),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneUsageLimit}
 */
function usageLimitRow(row) {
    return {
        orgId: String(row.orgId),
        projectId: row.projectId === null ? null : String(row.projectId),
        metric: String(row.metric),
        unit: String(row.unit),
        period: usageLimitPeriod(row.period),
        limitQuantity: Number(row.limitQuantity),
        updatedAtMs: Number(row.updatedAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneSecretRef}
 */
function secretRefRow(row) {
    return {
        orgId: String(row.orgId),
        projectId: row.projectId === null ? null : String(row.projectId),
        name: String(row.name),
        provider: String(row.provider),
        ref: String(row.ref),
        createdBy: row.createdBy === null ? null : String(row.createdBy),
        createdAtMs: Number(row.createdAtMs),
        rotatedAtMs: row.rotatedAtMs === null ? null : Number(row.rotatedAtMs),
    };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ControlPlaneAuditEvent}
 */
function auditRow(row) {
    return {
        id: Number(row.id),
        orgId: String(row.orgId),
        projectId: row.projectId === null ? null : String(row.projectId),
        actorId: row.actorId === null ? null : String(row.actorId),
        action: String(row.action),
        targetType: String(row.targetType),
        targetId: row.targetId === null ? null : String(row.targetId),
        occurredAtMs: Number(row.occurredAtMs),
        metadata: parseJsonObject(row.metadataJson),
    };
}

/**
 * @param {ControlPlaneSqlite} sqlite
 * @param {string} orgId
 * @param {string} projectId
 */
function assertProjectExists(sqlite, orgId, projectId) {
    const row = sqlite.query(`
SELECT 1 AS ok
FROM _smithers_cp_projects
WHERE org_id = ? AND project_id = ?
LIMIT 1
`).get(orgId, projectId);
    if (!row) {
        throw new SmithersError("INVALID_INPUT", `Control-plane project not found: ${projectId}`, { orgId, projectId });
    }
}

export class ControlPlaneStore {
    /** @type {ControlPlaneSqlite} */
    sqlite;

    /**
     * @param {ControlPlaneSqlite} sqlite
     */
    constructor(sqlite) {
        this.sqlite = sqlite;
        ensureControlPlaneTables(sqlite);
    }

    /**
     * @param {{ orgId?: string; slug: string; name: string; createdAtMs?: number }} input
     * @returns {ControlPlaneOrg}
     */
    createOrg(input) {
        const orgId = optionalId("orgId", input.orgId);
        const orgSlug = slug("slug", input.slug);
        const createdAtMs = timestamp(input.createdAtMs);
        try {
            this.sqlite.query(`
INSERT INTO _smithers_cp_orgs (org_id, slug, name, created_at_ms)
VALUES (?, ?, ?, ?)
`).run(orgId, orgSlug, nonEmptyString("name", input.name), createdAtMs);
        }
        catch (error) {
            if (isUniqueConstraintError(error, "_smithers_cp_orgs.slug")) {
                throwDuplicateSlugError(error, { entity: "org", slug: orgSlug });
            }
            throw error;
        }
        this.recordAuditEvent({
            orgId,
            actorId: "system",
            action: "org.create",
            targetType: "org",
            targetId: orgId,
            occurredAtMs: createdAtMs,
        });
        return this.getOrg(orgId);
    }

    /**
     * @param {string} orgId
     * @returns {ControlPlaneOrg | null}
     */
    getOrg(orgId) {
        const row = this.sqlite.query(`
SELECT org_id AS orgId, slug, name, created_at_ms AS createdAtMs
FROM _smithers_cp_orgs
WHERE org_id = ?
LIMIT 1
`).get(requiredId("orgId", orgId));
        return row ? orgRow(row) : null;
    }

    /**
     * @param {{ orgId: string; teamId?: string; slug: string; name: string; createdAtMs?: number }} input
     * @returns {ControlPlaneTeam}
     */
    createTeam(input) {
        const orgId = requiredId("orgId", input.orgId);
        const teamId = optionalId("teamId", input.teamId);
        const teamSlug = slug("slug", input.slug);
        const createdAtMs = timestamp(input.createdAtMs);
        try {
            this.sqlite.query(`
INSERT INTO _smithers_cp_teams (org_id, team_id, slug, name, created_at_ms)
VALUES (?, ?, ?, ?, ?)
`).run(orgId, teamId, teamSlug, nonEmptyString("name", input.name), createdAtMs);
        }
        catch (error) {
            if (isUniqueConstraintError(error, "_smithers_cp_teams.org_id, _smithers_cp_teams.slug")) {
                throwDuplicateSlugError(error, { entity: "team", slug: teamSlug, orgId });
            }
            throw error;
        }
        this.recordAuditEvent({
            orgId,
            action: "team.create",
            targetType: "team",
            targetId: teamId,
            occurredAtMs: createdAtMs,
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, team_id AS teamId, slug, name, created_at_ms AS createdAtMs
FROM _smithers_cp_teams
WHERE org_id = ? AND team_id = ?
LIMIT 1
`).get(orgId, teamId);
        return teamRow(row);
    }

    /**
     * @param {{ orgId: string; teamId: string; userId: string; role?: string; createdAtMs?: number }} input
     */
    addTeamMember(input) {
        const orgId = requiredId("orgId", input.orgId);
        const teamId = requiredId("teamId", input.teamId);
        const userId = requiredId("userId", input.userId);
        const role = nonEmptyString("role", input.role ?? "member");
        const createdAtMs = timestamp(input.createdAtMs);
        this.sqlite.query(`
INSERT INTO _smithers_cp_team_members (org_id, team_id, user_id, role, created_at_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(org_id, team_id, user_id) DO UPDATE SET role = excluded.role
`).run(orgId, teamId, userId, role, createdAtMs);
        this.recordAuditEvent({
            orgId,
            actorId: userId,
            action: "team.member.upsert",
            targetType: "team",
            targetId: teamId,
            occurredAtMs: createdAtMs,
            metadata: { role },
        });
    }

    /**
     * @param {{ orgId: string; projectId?: string; slug: string; name: string; metadata?: Record<string, unknown>; createdAtMs?: number }} input
     * @returns {ControlPlaneProject}
     */
    createProject(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = optionalId("projectId", input.projectId);
        const projectSlug = slug("slug", input.slug);
        const metadata = jsonObject(input.metadata);
        const createdAtMs = timestamp(input.createdAtMs);
        try {
            this.sqlite.query(`
INSERT INTO _smithers_cp_projects (org_id, project_id, slug, name, metadata_json, created_at_ms)
VALUES (?, ?, ?, ?, ?, ?)
`).run(orgId, projectId, projectSlug, nonEmptyString("name", input.name), JSON.stringify(metadata), createdAtMs);
        }
        catch (error) {
            if (isUniqueConstraintError(error, "_smithers_cp_projects.org_id, _smithers_cp_projects.slug")) {
                throwDuplicateSlugError(error, { entity: "project", slug: projectSlug, orgId });
            }
            throw error;
        }
        this.recordAuditEvent({
            orgId,
            projectId,
            action: "project.create",
            targetType: "project",
            targetId: projectId,
            occurredAtMs: createdAtMs,
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, slug, name, metadata_json AS metadataJson, created_at_ms AS createdAtMs
FROM _smithers_cp_projects
WHERE org_id = ? AND project_id = ?
LIMIT 1
`).get(orgId, projectId);
        return projectRow(row);
    }

    /**
     * @param {{ orgId: string; projectId: string; teamId: string; role?: string; createdAtMs?: number }} input
     */
    addProjectTeam(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = requiredId("projectId", input.projectId);
        const teamId = requiredId("teamId", input.teamId);
        const role = nonEmptyString("role", input.role ?? "viewer");
        const createdAtMs = timestamp(input.createdAtMs);
        this.sqlite.query(`
INSERT INTO _smithers_cp_project_teams (org_id, project_id, team_id, role, created_at_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(org_id, project_id, team_id) DO UPDATE SET role = excluded.role
`).run(orgId, projectId, teamId, role, createdAtMs);
        this.recordAuditEvent({
            orgId,
            projectId,
            action: "project.team.upsert",
            targetType: "team",
            targetId: teamId,
            occurredAtMs: createdAtMs,
            metadata: { role },
        });
    }

    /**
     * @param {{ orgId: string; plan: string; billingCustomerId?: string | null; status?: string; updatedAtMs?: number }} input
     * @returns {ControlPlaneBillingAccount}
     */
    upsertBillingAccount(input) {
        const orgId = requiredId("orgId", input.orgId);
        const updatedAtMs = timestamp(input.updatedAtMs);
        const status = nonEmptyString("status", input.status ?? "active");
        this.sqlite.query(`
INSERT INTO _smithers_cp_billing_accounts (org_id, plan, billing_customer_id, status, updated_at_ms)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(org_id) DO UPDATE SET
  plan = excluded.plan,
  billing_customer_id = excluded.billing_customer_id,
  status = excluded.status,
  updated_at_ms = excluded.updated_at_ms
`).run(orgId, nonEmptyString("plan", input.plan), input.billingCustomerId ?? null, status, updatedAtMs);
        this.recordAuditEvent({
            orgId,
            action: "billing.account.upsert",
            targetType: "billing_account",
            targetId: orgId,
            occurredAtMs: updatedAtMs,
            metadata: { plan: input.plan, status },
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, plan, billing_customer_id AS billingCustomerId, status, updated_at_ms AS updatedAtMs
FROM _smithers_cp_billing_accounts
WHERE org_id = ?
LIMIT 1
`).get(orgId);
        return billingRow(row);
    }

    /**
     * @param {{ orgId: string; providerId?: string; type: "saml" | "oidc" | string; issuer: string; ssoUrl?: string | null; certificateRef?: string | null; status?: string; metadata?: Record<string, unknown>; createdAtMs?: number; updatedAtMs?: number }} input
     * @returns {ControlPlaneIdentityProvider}
     */
    upsertIdentityProvider(input) {
        const orgId = requiredId("orgId", input.orgId);
        const providerId = optionalId("providerId", input.providerId);
        const metadata = jsonObject(input.metadata);
        const updatedAtMs = timestamp(input.updatedAtMs);
        const createdAtMs = timestamp(input.createdAtMs ?? updatedAtMs);
        const status = nonEmptyString("status", input.status ?? "active");
        this.sqlite.query(`
INSERT INTO _smithers_cp_identity_providers (
  org_id, provider_id, type, issuer, sso_url, certificate_ref, status, metadata_json, created_at_ms, updated_at_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(org_id, provider_id) DO UPDATE SET
  type = excluded.type,
  issuer = excluded.issuer,
  sso_url = excluded.sso_url,
  certificate_ref = excluded.certificate_ref,
  status = excluded.status,
  metadata_json = excluded.metadata_json,
  updated_at_ms = excluded.updated_at_ms
`).run(
            orgId,
            providerId,
            nonEmptyString("type", input.type),
            nonEmptyString("issuer", input.issuer),
            input.ssoUrl ? nonEmptyString("ssoUrl", input.ssoUrl) : null,
            input.certificateRef ? nonEmptyString("certificateRef", input.certificateRef) : null,
            status,
            JSON.stringify(metadata),
            createdAtMs,
            updatedAtMs,
        );
        this.recordAuditEvent({
            orgId,
            action: "identity_provider.upsert",
            targetType: "identity_provider",
            targetId: providerId,
            occurredAtMs: updatedAtMs,
            metadata: { type: input.type, status },
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, provider_id AS providerId, type, issuer, sso_url AS ssoUrl, certificate_ref AS certificateRef, status, metadata_json AS metadataJson, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
FROM _smithers_cp_identity_providers
WHERE org_id = ? AND provider_id = ?
LIMIT 1
`).get(orgId, providerId);
        return identityProviderRow(row);
    }

    /**
     * @param {{ orgId: string; status?: string }} input
     * @returns {ControlPlaneIdentityProvider[]}
     */
    listIdentityProviders(input) {
        const orgId = requiredId("orgId", input.orgId);
        const status = input.status ? nonEmptyString("status", input.status) : null;
        const sql = status
            ? `
SELECT org_id AS orgId, provider_id AS providerId, type, issuer, sso_url AS ssoUrl, certificate_ref AS certificateRef, status, metadata_json AS metadataJson, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
FROM _smithers_cp_identity_providers
WHERE org_id = ? AND status = ?
ORDER BY provider_id
`
            : `
SELECT org_id AS orgId, provider_id AS providerId, type, issuer, sso_url AS ssoUrl, certificate_ref AS certificateRef, status, metadata_json AS metadataJson, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
FROM _smithers_cp_identity_providers
WHERE org_id = ?
ORDER BY provider_id
`;
        const args = status ? [orgId, status] : [orgId];
        return this.sqlite.query(sql).all(...args).map(identityProviderRow);
    }

    /**
     * @param {{ orgId: string; projectId?: string | null; runId?: string | null; metric: string; quantity: number; unit?: string; observedAtMs?: number; metadata?: Record<string, unknown> }} input
     * @returns {ControlPlaneUsageEvent}
     */
    recordUsage(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId ? requiredId("projectId", input.projectId) : null;
        if (projectId) {
            assertProjectExists(this.sqlite, orgId, projectId);
        }
        const observedAtMs = timestamp(input.observedAtMs);
        const metadata = jsonObject(input.metadata);
        this.sqlite.query(`
INSERT INTO _smithers_cp_usage_events (org_id, project_id, run_id, metric, quantity, unit, observed_at_ms, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
            orgId,
            projectId,
            input.runId ? requiredId("runId", input.runId) : null,
            nonEmptyString("metric", input.metric),
            quantity(input.quantity),
            nonEmptyString("unit", input.unit ?? "count"),
            observedAtMs,
            JSON.stringify(metadata),
        );
        const idRow = this.sqlite.query("SELECT last_insert_rowid() AS id").get();
        if (!idRow) {
            throw new Error("control-plane: failed to read last_insert_rowid() after inserting usage event");
        }
        const id = idRow.id;
        const row = this.sqlite.query(`
SELECT id, org_id AS orgId, project_id AS projectId, run_id AS runId, metric, quantity, unit, observed_at_ms AS observedAtMs, metadata_json AS metadataJson
FROM _smithers_cp_usage_events
WHERE id = ?
LIMIT 1
`).get(id);
        return usageRow(row);
    }

    /**
     * @param {{ orgId: string; sinceMs?: number; untilMs?: number }} input
     * @returns {ControlPlaneUsageSummary[]}
     */
    summarizeUsage(input) {
        const orgId = requiredId("orgId", input.orgId);
        const sinceMs = input.sinceMs === undefined ? 0 : timestamp(input.sinceMs);
        const untilMs = input.untilMs === undefined ? Number.MAX_SAFE_INTEGER : timestamp(input.untilMs);
        return this.sqlite.query(`
SELECT org_id AS orgId, metric, unit, SUM(quantity) AS quantity
FROM _smithers_cp_usage_events
WHERE org_id = ? AND observed_at_ms >= ? AND observed_at_ms <= ?
GROUP BY org_id, metric, unit
ORDER BY metric, unit
`).all(orgId, sinceMs, untilMs).map((row) => ({
            orgId: String(row.orgId),
            metric: String(row.metric),
            unit: String(row.unit),
            quantity: Number(row.quantity),
        }));
    }

    /**
     * @param {{ orgId: string; projectId?: string | null; metric: string; unit?: string; period?: string; limitQuantity: number; updatedAtMs?: number }} input
     * @returns {ControlPlaneUsageLimit}
     */
    setUsageLimit(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId ? requiredId("projectId", input.projectId) : null;
        if (projectId) {
            assertProjectExists(this.sqlite, orgId, projectId);
        }
        const metric = nonEmptyString("metric", input.metric);
        const unit = nonEmptyString("unit", input.unit ?? "count");
        const period = usageLimitPeriod(input.period ?? "monthly");
        const limitValue = quantity(input.limitQuantity);
        const updatedAtMs = timestamp(input.updatedAtMs);
        this.sqlite.query(`
INSERT INTO _smithers_cp_usage_limits (org_id, project_key, project_id, metric, unit, period, limit_quantity, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(org_id, project_key, metric, unit, period) DO UPDATE SET
  project_id = excluded.project_id,
  limit_quantity = excluded.limit_quantity,
  updated_at_ms = excluded.updated_at_ms
`).run(orgId, projectKey(projectId), projectId, metric, unit, period, limitValue, updatedAtMs);
        this.recordAuditEvent({
            orgId,
            projectId,
            action: "usage_limit.upsert",
            targetType: "usage_limit",
            targetId: projectId ?? orgId,
            occurredAtMs: updatedAtMs,
            metadata: { metric, unit, period, limitQuantity: limitValue },
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, metric, unit, period, limit_quantity AS limitQuantity, updated_at_ms AS updatedAtMs
FROM _smithers_cp_usage_limits
WHERE org_id = ? AND project_key = ? AND metric = ? AND unit = ? AND period = ?
LIMIT 1
`).get(orgId, projectKey(projectId), metric, unit, period);
        return usageLimitRow(row);
    }

    /**
     * @param {{ orgId: string; projectId?: string | null; metric: string; unit?: string; period?: string; sinceMs?: number; untilMs?: number }} input
     * @returns {ControlPlaneUsageLimitCheck | null}
     */
    checkUsageLimit(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId ? requiredId("projectId", input.projectId) : null;
        const metric = nonEmptyString("metric", input.metric);
        const unit = nonEmptyString("unit", input.unit ?? "count");
        const period = usageLimitPeriod(input.period ?? "monthly");
        const limitRowRaw = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, metric, unit, period, limit_quantity AS limitQuantity, updated_at_ms AS updatedAtMs
FROM _smithers_cp_usage_limits
WHERE org_id = ? AND project_key = ? AND metric = ? AND unit = ? AND period = ?
LIMIT 1
`).get(orgId, projectKey(projectId), metric, unit, period);
        if (!limitRowRaw) {
            return null;
        }
        const untilMs = input.untilMs === undefined ? timestamp(undefined) : timestamp(input.untilMs);
        const periodMs = USAGE_LIMIT_PERIODS.get(period) ?? 0;
        const sinceMs = input.sinceMs === undefined ? Math.max(0, untilMs - periodMs) : timestamp(input.sinceMs);
        const usageSql = projectId
            ? `
SELECT COALESCE(SUM(quantity), 0) AS usedQuantity
FROM _smithers_cp_usage_events
WHERE org_id = ? AND project_id = ? AND metric = ? AND unit = ? AND observed_at_ms >= ? AND observed_at_ms <= ?
`
            : `
SELECT COALESCE(SUM(quantity), 0) AS usedQuantity
FROM _smithers_cp_usage_events
WHERE org_id = ? AND metric = ? AND unit = ? AND observed_at_ms >= ? AND observed_at_ms <= ?
`;
        const usageArgs = projectId
            ? [orgId, projectId, metric, unit, sinceMs, untilMs]
            : [orgId, metric, unit, sinceMs, untilMs];
        const usageRowRaw = this.sqlite.query(usageSql).get(...usageArgs);
        const limit = usageLimitRow(limitRowRaw);
        const usedQuantity = Number(usageRowRaw?.usedQuantity ?? 0);
        const remainingQuantity = Math.max(0, limit.limitQuantity - usedQuantity);
        return {
            ...limit,
            usedQuantity,
            remainingQuantity,
            exceeded: usedQuantity > limit.limitQuantity,
        };
    }

    /**
     * @param {{ orgId: string; projectId?: string | null; name: string; provider: string; ref: string; createdBy?: string | null; createdAtMs?: number; rotatedAtMs?: number | null }} input
     * @returns {ControlPlaneSecretRef}
     */
    putSecretRef(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId ? requiredId("projectId", input.projectId) : null;
        if (projectId) {
            assertProjectExists(this.sqlite, orgId, projectId);
        }
        const secretProjectKey = projectKey(projectId);
        const name = nonEmptyString("name", input.name);
        const createdAtMs = timestamp(input.createdAtMs);
        const rotatedAtMs = input.rotatedAtMs === undefined || input.rotatedAtMs === null
            ? null
            : timestamp(input.rotatedAtMs);
        const provider = nonEmptyString("provider", input.provider);
        const ref = nonEmptyString("ref", input.ref);
        const createdBy = input.createdBy ? requiredId("createdBy", input.createdBy) : null;
        this.sqlite.query(`
DELETE FROM _smithers_cp_secret_refs
WHERE org_id = ? AND project_key = ? AND name = ?
`).run(orgId, secretProjectKey, name);
        this.sqlite.query(`
INSERT INTO _smithers_cp_secret_refs (org_id, project_key, project_id, name, provider, ref, created_by, created_at_ms, rotated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
            orgId,
            secretProjectKey,
            projectId,
            name,
            provider,
            ref,
            createdBy,
            createdAtMs,
            rotatedAtMs,
        );
        this.recordAuditEvent({
            orgId,
            projectId,
            actorId: createdBy,
            action: "secret_ref.upsert",
            targetType: "secret_ref",
            targetId: name,
            occurredAtMs: rotatedAtMs ?? createdAtMs,
            metadata: { provider },
        });
        const row = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, name, provider, ref, created_by AS createdBy, created_at_ms AS createdAtMs, rotated_at_ms AS rotatedAtMs
FROM _smithers_cp_secret_refs
WHERE org_id = ? AND project_key = ? AND name = ?
LIMIT 1
`).get(orgId, secretProjectKey, name);
        return secretRefRow(row);
    }

    /**
     * @param {{ orgId: string; projectId?: string | null }} input
     * @returns {ControlPlaneSecretRef[]}
     */
    listSecretRefs(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId === undefined ? undefined : input.projectId;
        const sql = projectId === undefined
            ? `
SELECT org_id AS orgId, project_id AS projectId, name, provider, ref, created_by AS createdBy, created_at_ms AS createdAtMs, rotated_at_ms AS rotatedAtMs
FROM _smithers_cp_secret_refs
WHERE org_id = ?
ORDER BY name
`
            : `
SELECT org_id AS orgId, project_id AS projectId, name, provider, ref, created_by AS createdBy, created_at_ms AS createdAtMs, rotated_at_ms AS rotatedAtMs
FROM _smithers_cp_secret_refs
WHERE org_id = ? AND project_key = ?
ORDER BY name
`;
        const args = projectId === undefined ? [orgId] : [orgId, projectKey(projectId ? requiredId("projectId", projectId) : null)];
        return this.sqlite.query(sql).all(...args).map(secretRefRow);
    }

    /**
     * @param {{ orgId: string; projectId?: string | null; actorId?: string | null; action: string; targetType: string; targetId?: string | null; occurredAtMs?: number; metadata?: Record<string, unknown> }} input
     * @returns {ControlPlaneAuditEvent}
     */
    recordAuditEvent(input) {
        const orgId = requiredId("orgId", input.orgId);
        const projectId = input.projectId ? requiredId("projectId", input.projectId) : null;
        if (projectId) {
            assertProjectExists(this.sqlite, orgId, projectId);
        }
        const occurredAtMs = timestamp(input.occurredAtMs);
        const metadata = jsonObject(input.metadata);
        this.sqlite.query(`
INSERT INTO _smithers_cp_audit_events (org_id, project_id, actor_id, action, target_type, target_id, occurred_at_ms, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
            orgId,
            projectId,
            input.actorId ? requiredId("actorId", input.actorId) : null,
            nonEmptyString("action", input.action),
            nonEmptyString("targetType", input.targetType),
            input.targetId ? requiredId("targetId", input.targetId) : null,
            occurredAtMs,
            JSON.stringify(metadata),
        );
        const idRow = this.sqlite.query("SELECT last_insert_rowid() AS id").get();
        if (!idRow) {
            throw new Error("control-plane: failed to read last_insert_rowid() after inserting audit event");
        }
        const id = idRow.id;
        const row = this.sqlite.query(`
SELECT id, org_id AS orgId, project_id AS projectId, actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, occurred_at_ms AS occurredAtMs, metadata_json AS metadataJson
FROM _smithers_cp_audit_events
WHERE id = ?
LIMIT 1
`).get(id);
        return auditRow(row);
    }

    /**
     * @param {{ orgId: string; sinceMs?: number; untilMs?: number; exportedAtMs?: number }} input
     * @returns {ControlPlaneExport}
     */
    exportOrgAudit(input) {
        const orgId = requiredId("orgId", input.orgId);
        const org = this.getOrg(orgId);
        if (!org) {
            throw new SmithersError("INVALID_INPUT", `Control-plane org not found: ${orgId}`, { orgId });
        }
        const sinceMs = input.sinceMs === undefined ? 0 : timestamp(input.sinceMs);
        const untilMs = input.untilMs === undefined ? Number.MAX_SAFE_INTEGER : timestamp(input.untilMs);
        const projects = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, slug, name, metadata_json AS metadataJson, created_at_ms AS createdAtMs
FROM _smithers_cp_projects
WHERE org_id = ?
ORDER BY slug
`).all(orgId).map(projectRow);
        const teams = this.sqlite.query(`
SELECT org_id AS orgId, team_id AS teamId, slug, name, created_at_ms AS createdAtMs
FROM _smithers_cp_teams
WHERE org_id = ?
ORDER BY slug
`).all(orgId).map(teamRow);
        const billingRaw = this.sqlite.query(`
SELECT org_id AS orgId, plan, billing_customer_id AS billingCustomerId, status, updated_at_ms AS updatedAtMs
FROM _smithers_cp_billing_accounts
WHERE org_id = ?
LIMIT 1
`).get(orgId);
        const identityProviders = this.sqlite.query(`
SELECT org_id AS orgId, provider_id AS providerId, type, issuer, sso_url AS ssoUrl, certificate_ref AS certificateRef, status, metadata_json AS metadataJson, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
FROM _smithers_cp_identity_providers
WHERE org_id = ?
ORDER BY provider_id
`).all(orgId).map(identityProviderRow);
        const usageLimits = this.sqlite.query(`
SELECT org_id AS orgId, project_id AS projectId, metric, unit, period, limit_quantity AS limitQuantity, updated_at_ms AS updatedAtMs
FROM _smithers_cp_usage_limits
WHERE org_id = ?
ORDER BY project_key, metric, unit, period
`).all(orgId).map(usageLimitRow);
        const auditEvents = this.sqlite.query(`
SELECT id, org_id AS orgId, project_id AS projectId, actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, occurred_at_ms AS occurredAtMs, metadata_json AS metadataJson
FROM _smithers_cp_audit_events
WHERE org_id = ? AND occurred_at_ms >= ? AND occurred_at_ms <= ?
ORDER BY occurred_at_ms, id
`).all(orgId, sinceMs, untilMs).map(auditRow);
        return {
            exportedAtMs: timestamp(input.exportedAtMs),
            org,
            projects,
            teams,
            billing: billingRaw ? billingRow(billingRaw) : null,
            identityProviders,
            usage: this.summarizeUsage({ orgId, sinceMs, untilMs }),
            usageLimits,
            secretRefs: this.listSecretRefs({ orgId }),
            auditEvents,
        };
    }
}
