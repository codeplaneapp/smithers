import { describe, expect, test } from "bun:test";
import * as source from "../src/index.ts";

/**
 * Package-export/runtime parity gate. The published `@smithers-orchestrator/
 * testing` entrypoint is the COMMITTED src/index.js artifact (via the
 * package.json exports map), while most in-repo suites resolve the tsconfig
 * alias straight to src/index.ts. A stale committed bundle can therefore stay
 * green everywhere the alias applies while shipping different behavior. This
 * gate resolves the real package export (self-reference through the exports
 * map — no tsconfig alias applies to it here), proves it is the JavaScript
 * artifact, and pins its observable behavior to the TypeScript source for the
 * exact surfaces prior stale bundles drifted on: boundary-error
 * serialization's native fields, real-adapter advertised cut points, and
 * cut-point receipt/ambiguity emission.
 */
const shippedPath = Bun.resolveSync("@smithers-orchestrator/testing", import.meta.dir);
const shipped = (await import(shippedPath)) as typeof source;

describe("published artifact parity", () => {
  test("the package export resolves to the committed src/index.js artifact, not the TypeScript source", () => {
    expect(shippedPath.endsWith("/packages/testing/src/index.js")).toBe(true);
    // If the resolver had rewritten the export to index.ts, both namespaces
    // would be the SAME module instance; distinctness proves the committed
    // JavaScript genuinely loaded alongside the source.
    expect(shipped as unknown).not.toBe(source as unknown);
  });

  test("shipped serializeBoundaryError carries family-specific native fields identically to source", () => {
    const cause = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5, byteOffset: -1 });
    const error = Object.assign(new Error("write failed. See https://smithers.sh/reference/errors"), {
      code: "DB_WRITE_FAILED",
      summary: "write failed",
      docsUrl: "https://smithers.sh/reference/errors",
      details: { table: "runs" },
      syscall: "write",
      cause,
    });
    const shippedSerialized = shipped.serializeBoundaryError(error);
    expect(JSON.stringify(shippedSerialized)).toBe(JSON.stringify(source.serializeBoundaryError(error)));
    // Regression for the stale bundle that dropped native own-fields: the
    // shipped serializer must surface errno/byteOffset/syscall, not just
    // {name,message,code}.
    const record = shippedSerialized as { native?: Record<string, unknown>; cause?: { native?: Record<string, unknown> } };
    expect(record.native).toEqual({ syscall: "write" });
    expect(record.cause?.native).toEqual({ byteOffset: -1, errno: 5 });
  });

  test("shipped realDbAdapter advertises exactly the cut points the source adapter can execute", () => {
    const open = async () => { throw new Error("never admitted"); };
    const shippedAdapter = shipped.realDbAdapter({ open });
    const sourceAdapter = source.realDbAdapter({ open });
    expect([...(shippedAdapter.supportedCutPoints ?? [])].sort()).toEqual([...(sourceAdapter.supportedCutPoints ?? [])].sort());
    expect(shippedAdapter.identity).toBe(sourceAdapter.identity);
  });

  const ackScenario = (M: typeof source) =>
    M.runScenario(
      M.scenario("shipped-parity-ack", {
        steps: [M.step("work", { runnerBinding: "parity:ack:work:v1", run: (runtime) => runtime.effect("write", () => "ok") })],
        faults: [M.fault("probe", "after-journal-before-ack", "completion-cas")],
      }),
      { waitBudget: 5_000 },
    );
  const leaseScenario = (M: typeof source) =>
    M.runScenario(
      M.scenario("shipped-parity-lease", {
        steps: [M.step("work", { runnerBinding: "test:shipped-parity:slow:v1", run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })],
        faults: [M.fault("probe", "during-task", "heartbeat")],
      }),
      { waitBudget: 5_000 },
    );
  const projection = (result: Awaited<ReturnType<typeof source.runScenario>>) =>
    JSON.parse(JSON.stringify({
      status: result.status,
      code: result.error?.code ?? null,
      replayIdentity: result.replayIdentity,
      ambiguity: result.ambiguity,
      trace: result.trace,
      controlLog: result.controlLog,
    }));

  test("shipped runScenario emits identical ack cut-point receipts and ambiguity to source", async () => {
    const fromShipped = await ackScenario(shipped);
    const fromSource = await ackScenario(source);
    expect(fromShipped.status).toBe("failed");
    expect(fromShipped.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    expect(fromShipped.ambiguity.map((item) => item.outcome)).toEqual(["journal-applied-ack-missing"]);
    expect(projection(fromShipped)).toEqual(projection(fromSource));
  });

  test("shipped runScenario emits lease-lost only from the observed transition, identically to source", async () => {
    const fromShipped = await leaseScenario(shipped);
    const fromSource = await leaseScenario(source);
    expect(fromShipped.status).toBe("failed");
    expect(fromShipped.ambiguity.map((item) => item.outcome)).toEqual(["lease-lost"]);
    expect(projection(fromShipped)).toEqual(projection(fromSource));
  });
});
