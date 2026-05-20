import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ControlPlaneStore, ensureControlPlaneTables } from "../src/index.js";

function makeStore() {
  const sqlite = new Database(":memory:");
  const store = new ControlPlaneStore(sqlite);
  return { sqlite, store };
}

describe("ControlPlaneStore", () => {
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
      expect(exported.usage).toEqual([
        { orgId: "org_acme", metric: "agent_runtime_ms", unit: "ms", quantity: 200 },
      ]);
      expect(exported.auditEvents.map((event) => event.action)).toEqual([
        "org.create",
        "team.create",
        "team.member.upsert",
        "project.create",
        "project.team.upsert",
        "billing.account.upsert",
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

      expect(ref).toMatchObject({
        name: "deploy-token",
        provider: "aws-secrets-manager",
        ref: "arn:aws:secretsmanager:us-east-1:123:secret:deploy",
      });
      const rawRows = sqlite.query("SELECT * FROM _smithers_cp_secret_refs").all();
      expect(JSON.stringify(rawRows)).not.toContain("super-secret-value");
      expect(store.listSecretRefs({ orgId: "org_secure", projectId: "project_api" })).toEqual([ref]);
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
