/**
 * REAL-backend integration: the smithers electric-proxy in front of a REAL
 * ElectricSQL + Postgres (wal_level=logical) fixture — no mocks (design §5.3,
 * §13). Proves the proxy auth/scope/where-fill criterion against real Electric:
 * read shapes are run-scoped, the where template is filled from the granted run
 * ids, an out-of-grant run is NOT returned, and Authorization is stripped before
 * forwarding. SKIPS cleanly when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSmithersElectricProxy } from "../src/index.ts";
import {
  isDockerFixtureAvailable,
  startElectricFixture,
  type ElectricFixture,
} from "./fixtures/electricFixture.ts";

const dockerAvailable = isDockerFixtureAvailable();

function runIdsIn(body: string): Set<string> {
  const ids = new Set<string>();
  try {
    const messages = JSON.parse(body) as Array<{ value?: { run_id?: string } }>;
    for (const message of messages) {
      const runId = message.value?.run_id;
      if (typeof runId === "string") ids.add(runId);
    }
  } catch {
    // non-JSON (e.g. SSE) — fall back to substring checks below
  }
  return ids;
}

describe.skipIf(!dockerAvailable)("electric-proxy over a real Electric + Postgres fixture", () => {
  let fixture: ElectricFixture;

  beforeAll(async () => {
    fixture = await startElectricFixture();
    fixture.seedRuns([
      { runId: "run-1", status: "completed" },
      { runId: "run-2", status: "running" },
      { runId: "run-3", status: "queued" },
    ]);
  }, 200_000);

  afterAll(() => {
    fixture?.teardown();
  });

  test("fronts real Electric: fills the where template from grants and filters out un-granted runs", async () => {
    let forwardedAuth: string | null = "unset";
    let forwardedWhere: string | null = "unset";
    const proxy = createSmithersElectricProxy({
      electricUrl: fixture.shapeUrl,
      authenticate: () => ({
        principalId: "t",
        userId: "t",
        scopes: ["run:read"],
        grantedRunIds: ["run-1", "run-2"],
      }),
      // Wrap the global fetch so we can assert what the proxy forwards upstream,
      // while still hitting the REAL Electric service.
      fetchClient: async (url, init) => {
        const upstream = new URL(String(url));
        forwardedWhere = upstream.searchParams.get("where");
        forwardedAuth = new Headers(init?.headers).get("authorization");
        return fetch(upstream, init);
      },
    });

    // Electric requires an explicit initial offset; the proxy forwards it
    // verbatim. The shape is opened against _smithers_runs with NO client where,
    // so the proxy must synthesize the run-scoped predicate from the grants.
    let body = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await proxy.fetch(
        new Request("http://proxy.local/v1/shape?table=_smithers_runs&offset=-1", {
          headers: { authorization: "Bearer client-secret" },
        }),
      );
      expect(response.status).toBe(200);
      body = await response.text();
      if (runIdsIn(body).has("run-1")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const ids = runIdsIn(body);
    expect(ids.has("run-1")).toBe(true);
    expect(ids.has("run-2")).toBe(true);
    // run-3 is outside the grant: the proxy-filled predicate must exclude it.
    expect(ids.has("run-3")).toBe(false);

    // The where template was filled from the granted run ids...
    expect(forwardedWhere).toBe("run_id IN ('run-1','run-2')");
    // ...and the client Authorization was stripped before forwarding to Electric.
    expect(forwardedAuth).toBeNull();
    expect(proxy.metrics.snapshot().shapeOpens).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("rejects a where that broadens beyond the granted run ids against real Electric", async () => {
    let upstreamHits = 0;
    const proxy = createSmithersElectricProxy({
      electricUrl: fixture.shapeUrl,
      authenticate: () => ({ principalId: "t", scopes: ["run:read"], grantedRunIds: ["run-1"] }),
      fetchClient: async (url, init) => {
        upstreamHits += 1;
        return fetch(url, init);
      },
    });

    const response = await proxy.fetch(
      new Request(
        "http://proxy.local/v1/shape?table=_smithers_runs&offset=-1&where=" +
          encodeURIComponent("run_id IN ('run-1','run-3')"),
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unauthorized value");
    // Rejected before ever touching real Electric.
    expect(upstreamHits).toBe(0);
  }, 30_000);
});
