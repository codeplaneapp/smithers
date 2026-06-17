import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { ControlPlaneStore, ensureControlPlaneTables } from "../src/index.js";

function makeStore() {
  const sqlite = new Database(":memory:");
  const store = new ControlPlaneStore(sqlite);
  return { sqlite, store };
}

describe("ControlPlaneStore", () => {
  test("accepts one-character org, team, and project slugs", () => {
    const { sqlite, store } = makeStore();
    try {
      const org = store.createOrg({ orgId: "org_x", slug: "x", name: "X", createdAtMs: 1 });
      const team = store.createTeam({ orgId: org.orgId, teamId: "team_a", slug: "a", name: "A", createdAtMs: 2 });
      const project = store.createProject({ orgId: org.orgId, projectId: "project_b", slug: "b", name: "B", createdAtMs: 3 });
      expect(team.slug).toBe("a");
      expect(project.slug).toBe("b");
    }
    finally {
      sqlite.close();
    }
  });

  test("maps duplicate slugs to typed Smithers errors", () => {
    const { sqlite, store } = makeStore();
    try {
      store.createOrg({ orgId: "org_acme", slug: "acme", name: "Acme", createdAtMs: 1 });

      expect(() =>
        store.createOrg({ orgId: "org_other", slug: "acme", name: "Other", createdAtMs: 2 }),
      ).toThrow(SmithersError);
      expect(() =>
        store.createOrg({ orgId: "org_other", slug: "acme", name: "Other", createdAtMs: 2 }),
      ).toThrow(expect.objectContaining({
        code: "DUPLICATE_ID",
        summary: "Duplicate control-plane org slug: acme",
        details: { kind: "control-plane.org", id: "acme", slug: "acme" },
      }));

      store.createTeam({ orgId: "org_acme", teamId: "team_ops", slug: "ops", name: "Ops", createdAtMs: 3 });
      expect(() =>
        store.createTeam({ orgId: "org_acme", teamId: "team_support", slug: "ops", name: "Support", createdAtMs: 4 }),
      ).toThrow(expect.objectContaining({
        code: "DUPLICATE_ID",
        summary: "Duplicate control-plane team slug: ops",
        details: { kind: "control-plane.team", id: "ops", slug: "ops", orgId: "org_acme" },
      }));

      store.createProject({ orgId: "org_acme", projectId: "project_api", slug: "api", name: "API", createdAtMs: 5 });
      expect(() =>
        store.createProject({ orgId: "org_acme", projectId: "project_web", slug: "api", name: "Web", createdAtMs: 6 }),
      ).toThrow(expect.objectContaining({
        code: "DUPLICATE_ID",
        summary: "Duplicate control-plane project slug: api",
        details: { kind: "control-plane.project", id: "api", slug: "api", orgId: "org_acme" },
      }));
    }
    finally {
      sqlite.close();
    }
  });

  test("creates org, team, project, billing account, usage rows, and audit export", () => {
    const { sqlite, store } = makeStore();
    try {
      const org = store.createOrg({ orgId: "org_acme", slug: "acme", name: "Acme", createdAtMs: 10 });
      const team = store.createTeam({ orgId: org.orgId, teamId: "team_ops", slug: "ops", name: "Operators", createdAtMs: 20 });
      store.addTeamMember({ orgId: org.orgId, teamId: team.teamId, userId: "user_1", role: "admin", createdAtMs: 30 });
      const project = store.createProject({
        orgId: org.orgId,
        projectId: "project_app",
        slug: "app",
        name: "App",
        metadata: { environment: "prod" },
        createdAtMs: 40,
      });
      store.addProjectTeam({ orgId: org.orgId, projectId: project.projectId, teamId: team.teamId, role: "operator", createdAtMs: 50 });
      const billing = store.upsertBillingAccount({
        orgId: org.orgId,
        plan: "business",
        billingCustomerId: "cus_123",
        status: "trialing",
        updatedAtMs: 60,
      });
      const idp = store.upsertIdentityProvider({
        orgId: org.orgId,
        providerId: "idp_okta",
        type: "saml",
        issuer: "https://acme.okta.com",
        ssoUrl: "https://acme.okta.com/app/smithers/sso/saml",
        certificateRef: "vault://identity/acme-okta-cert",
        metadata: { domains: ["acme.test"] },
        createdAtMs: 65,
        updatedAtMs: 65,
      });
      const usageLimit = store.setUsageLimit({
        orgId: org.orgId,
        projectId: project.projectId,
        metric: "agent_runtime_ms",
        unit: "ms",
        period: "monthly",
        limitQuantity: 250,
        updatedAtMs: 66,
      });
      const firstUsage = store.recordUsage({
        orgId: org.orgId,
        projectId: project.projectId,
        runId: "run_1",
        metric: "agent_runtime_ms",
        quantity: 125,
        unit: "ms",
        observedAtMs: 70,
        metadata: { workflow: "review" },
      });
      store.recordUsage({
        orgId: org.orgId,
        projectId: project.projectId,
        runId: "run_2",
        metric: "agent_runtime_ms",
        quantity: 75,
        unit: "ms",
        observedAtMs: 80,
      });

      expect(billing).toMatchObject({ orgId: "org_acme", plan: "business", status: "trialing" });
      expect(idp).toMatchObject({
        orgId: "org_acme",
        providerId: "idp_okta",
        type: "saml",
        status: "active",
        metadata: { domains: ["acme.test"] },
      });
      expect(store.listIdentityProviders({ orgId: org.orgId })).toEqual([idp]);
      expect(usageLimit).toMatchObject({
        orgId: "org_acme",
        projectId: "project_app",
        metric: "agent_runtime_ms",
        limitQuantity: 250,
      });
      expect(store.checkUsageLimit({
        orgId: org.orgId,
        projectId: project.projectId,
        metric: "agent_runtime_ms",
        unit: "ms",
        period: "monthly",
        untilMs: 80,
      })).toMatchObject({
        limitQuantity: 250,
        usedQuantity: 200,
        remainingQuantity: 50,
        exceeded: false,
      });
      expect(firstUsage).toMatchObject({
        orgId: "org_acme",
        projectId: "project_app",
        metric: "agent_runtime_ms",
        quantity: 125,
        metadata: { workflow: "review" },
      });
      expect(store.summarizeUsage({ orgId: org.orgId })).toEqual([
        { orgId: "org_acme", metric: "agent_runtime_ms", unit: "ms", quantity: 200 },
      ]);

      const exported = store.exportOrgAudit({ orgId: org.orgId, exportedAtMs: 100 });
      expect(exported.org).toEqual(org);
      expect(exported.projects).toEqual([project]);
      expect(exported.teams).toEqual([team]);
      expect(exported.billing).toEqual(billing);
      expect(exported.identityProviders).toEqual([idp]);
      expect(exported.usage).toEqual([
        { orgId: "org_acme", metric: "agent_runtime_ms", unit: "ms", quantity: 200 },
      ]);
      expect(exported.usageLimits).toEqual([usageLimit]);
      expect(exported.auditEvents.map((event) => event.action)).toEqual([
        "org.create",
        "team.create",
        "team.member.upsert",
        "project.create",
        "project.team.upsert",
        "billing.account.upsert",
        "identity_provider.upsert",
        "usage_limit.upsert",
      ]);
    }
    finally {
      sqlite.close();
    }
  });

  test("stores secret manager references without storing secret values", () => {
    const { sqlite, store } = makeStore();
    try {
      store.createOrg({ orgId: "org_secure", slug: "secure", name: "Secure", createdAtMs: 1 });
      store.createProject({ orgId: "org_secure", projectId: "project_api", slug: "api", name: "API", createdAtMs: 2 });
      const ref = store.putSecretRef({
        orgId: "org_secure",
        projectId: "project_api",
        name: "deploy-token",
        provider: "aws-secrets-manager",
        ref: "arn:aws:secretsmanager:us-east-1:123:secret:deploy",
        createdBy: "user_ops",
        createdAtMs: 3,
      });
      const rotated = store.putSecretRef({
        orgId: "org_secure",
        projectId: "project_api",
        name: "deploy-token",
        provider: "aws-secrets-manager",
        ref: "arn:aws:secretsmanager:us-east-1:123:secret:deploy-v2",
        createdBy: "user_ops",
        createdAtMs: 4,
      });

      expect(ref).toMatchObject({
        name: "deploy-token",
        provider: "aws-secrets-manager",
        ref: "arn:aws:secretsmanager:us-east-1:123:secret:deploy",
      });
      const rawRows = sqlite.query("SELECT * FROM _smithers_cp_secret_refs").all();
      expect(rawRows).toHaveLength(1);
      expect(JSON.stringify(rawRows)).not.toContain("super-secret-value");
      expect(store.listSecretRefs({ orgId: "org_secure", projectId: "project_api" })).toEqual([rotated]);
    }
    finally {
      sqlite.close();
    }
  });

  test("org-wide secret refs rotate through the non-null project key", () => {
    const { sqlite, store } = makeStore();
    try {
      store.createOrg({ orgId: "org_secret_org", slug: "secret-org", name: "Secret Org", createdAtMs: 1 });
      store.putSecretRef({
        orgId: "org_secret_org",
        name: "billing-token",
        provider: "vault",
        ref: "vault://billing-token-v1",
        createdAtMs: 2,
      });
      const rotated = store.putSecretRef({
        orgId: "org_secret_org",
        name: "billing-token",
        provider: "vault",
        ref: "vault://billing-token-v2",
        createdAtMs: 3,
      });

      expect(store.listSecretRefs({ orgId: "org_secret_org", projectId: null })).toEqual([rotated]);
      const rawRows = sqlite.query("SELECT project_key AS projectKey, project_id AS projectId, name, ref FROM _smithers_cp_secret_refs").all();
      expect(rawRows).toEqual([
        {
          projectKey: "__org__",
          projectId: null,
          name: "billing-token",
          ref: "vault://billing-token-v2",
        },
      ]);
      expect(() =>
        sqlite.query(`
INSERT INTO _smithers_cp_secret_refs (org_id, project_key, project_id, name, provider, ref, created_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?)
`).run("org_secret_org", "__org__", null, "billing-token", "vault", "vault://billing-token-v3", 4),
      ).toThrow();
    }
    finally {
      sqlite.close();
    }
  });

  test("usage limits support org-wide and project-scoped quota checks", () => {
    const { sqlite, store } = makeStore();
    try {
      store.createOrg({ orgId: "org_limits", slug: "limits", name: "Limits", createdAtMs: 1 });
      store.createProject({ orgId: "org_limits", projectId: "project_one", slug: "one", name: "One", createdAtMs: 2 });
      store.createProject({ orgId: "org_limits", projectId: "project_two", slug: "two", name: "Two", createdAtMs: 3 });
      store.setUsageLimit({ orgId: "org_limits", metric: "runs", unit: "count", period: "daily", limitQuantity: 3, updatedAtMs: 4 });
      store.setUsageLimit({ orgId: "org_limits", projectId: "project_one", metric: "runs", unit: "count", period: "daily", limitQuantity: 1, updatedAtMs: 5 });
      store.recordUsage({ orgId: "org_limits", projectId: "project_one", metric: "runs", quantity: 2, unit: "count", observedAtMs: 6 });
      store.recordUsage({ orgId: "org_limits", projectId: "project_two", metric: "runs", quantity: 1, unit: "count", observedAtMs: 7 });

      expect(store.checkUsageLimit({ orgId: "org_limits", metric: "runs", unit: "count", period: "daily", untilMs: 7 })).toMatchObject({
        usedQuantity: 3,
        remainingQuantity: 0,
        exceeded: false,
      });
      expect(store.checkUsageLimit({ orgId: "org_limits", projectId: "project_one", metric: "runs", unit: "count", period: "daily", untilMs: 7 })).toMatchObject({
        usedQuantity: 2,
        remainingQuantity: 0,
        exceeded: true,
      });
      expect(() =>
        store.setUsageLimit({ orgId: "org_limits", projectId: "project_missing", metric: "runs", limitQuantity: 1 }),
      ).toThrow("Control-plane project not found");
    }
    finally {
      sqlite.close();
    }
  });

  test("usage limit periods are validated and define default quota windows", () => {
    const { sqlite, store } = makeStore();
    try {
      store.createOrg({ orgId: "org_periods", slug: "periods", name: "Periods", createdAtMs: 1 });
      expect(() =>
        store.setUsageLimit({ orgId: "org_periods", metric: "runs", period: "forever", limitQuantity: 10, updatedAtMs: 2 }),
      ).toThrow("period must be one of");

      store.setUsageLimit({ orgId: "org_periods", metric: "runs", period: "monthly", limitQuantity: 10, updatedAtMs: 3 });
      store.recordUsage({ orgId: "org_periods", metric: "runs", quantity: 8, observedAtMs: 1_000 });
      store.recordUsage({ orgId: "org_periods", metric: "runs", quantity: 3, observedAtMs: 2_678_400_000 });

      expect(store.checkUsageLimit({ orgId: "org_periods", metric: "runs", period: "monthly", untilMs: 2_678_400_000 })).toMatchObject({
        usedQuantity: 3,
        remainingQuantity: 7,
        exceeded: false,
      });
      expect(() =>
        store.checkUsageLimit({ orgId: "org_periods", metric: "runs", period: "forever" }),
      ).toThrow("period must be one of");
    }
    finally {
      sqlite.close();
    }
  });

  test("foreign keys prevent orphan projects and cascade org deletion", () => {
    const { sqlite, store } = makeStore();
    try {
      expect(() =>
        store.createProject({
          orgId: "missing",
          projectId: "project_missing",
          slug: "missing",
          name: "Missing",
        }),
      ).toThrow();

      store.createOrg({ orgId: "org_delete", slug: "delete", name: "Delete", createdAtMs: 1 });
      store.createProject({ orgId: "org_delete", projectId: "project_delete", slug: "project", name: "Project", createdAtMs: 2 });
      store.recordUsage({ orgId: "org_delete", projectId: "project_delete", metric: "runs", quantity: 1, observedAtMs: 3 });

      sqlite.query("DELETE FROM _smithers_cp_orgs WHERE org_id = ?").run("org_delete");
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_cp_projects").get().count).toBe(0);
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_cp_usage_events").get().count).toBe(0);
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_cp_audit_events").get().count).toBe(0);
    }
    finally {
      sqlite.close();
    }
  });

  test("ensureControlPlaneTables is idempotent", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureControlPlaneTables(sqlite);
      ensureControlPlaneTables(sqlite);
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_smithers_cp_%' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toContain("_smithers_cp_orgs");
      expect(tables).toContain("_smithers_cp_audit_events");
    }
    finally {
      sqlite.close();
    }
  });

  test("migrates legacy nullable secret-ref primary keys to project_key", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
CREATE TABLE _smithers_cp_orgs (
  org_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
INSERT INTO _smithers_cp_orgs (org_id, slug, name, created_at_ms)
VALUES ('org_legacy', 'legacy', 'Legacy', 1);
CREATE TABLE _smithers_cp_secret_refs (
  org_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_by TEXT,
  created_at_ms INTEGER NOT NULL,
  rotated_at_ms INTEGER,
  PRIMARY KEY (org_id, project_id, name)
);
INSERT INTO _smithers_cp_secret_refs (org_id, project_id, name, provider, ref, created_at_ms)
VALUES ('org_legacy', NULL, 'token', 'vault', 'vault://old', 2);
INSERT INTO _smithers_cp_secret_refs (org_id, project_id, name, provider, ref, created_at_ms)
VALUES ('org_legacy', NULL, 'token', 'vault', 'vault://new', 3);
`);
      ensureControlPlaneTables(sqlite);
      const columns = sqlite.query("PRAGMA table_info(_smithers_cp_secret_refs)").all().map((column) => column.name);
      expect(columns).toContain("project_key");
      const store = new ControlPlaneStore(sqlite);
      expect(store.listSecretRefs({ orgId: "org_legacy", projectId: null })).toEqual([
        expect.objectContaining({
          name: "token",
          ref: "vault://new",
          projectId: null,
        }),
      ]);
    }
    finally {
      sqlite.close();
    }
  });

  test("rejects audit export for unknown orgs with a control-plane error", () => {
    const { sqlite, store } = makeStore();
    try {
      expect(() => store.exportOrgAudit({ orgId: "org_missing" })).toThrow("Control-plane org not found");
    }
    finally {
      sqlite.close();
    }
  });
});
