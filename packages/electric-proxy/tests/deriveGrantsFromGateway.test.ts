import { describe, expect, test } from "bun:test";
import { deriveGrantsFromGateway } from "../src/deriveGrantsFromGateway.js";

function fakeFetch(status: number, payload?: unknown): typeof fetch {
  return (async () =>
    new Response(status === 200 ? JSON.stringify({ payload }) : "", { status })) as unknown as typeof fetch;
}

describe("deriveGrantsFromGateway", () => {
  test("does not leak token material into principalId", async () => {
    const authorization = "Bearer super-secret-token-abcdef123456";
    const result = await deriveGrantsFromGateway(
      "http://gateway.local",
      authorization,
      fakeFetch(200, [{ runId: "run-1" }, { runId: "run-2" }]),
    );

    expect(result).not.toBeNull();
    expect(result?.principalId).not.toBe(authorization.slice(-12));
    expect(result?.principalId).not.toContain(authorization);
    expect(result?.principalId).not.toContain("super-secret-token");
  });

  test("principalId is opaque, stable, and distinct per token", async () => {
    const fetchClient = fakeFetch(200, [{ runId: "run-1" }, { runId: "run-2" }]);

    const first = await deriveGrantsFromGateway("http://gateway.local", "Bearer token-a", fetchClient);
    const second = await deriveGrantsFromGateway("http://gateway.local", "Bearer token-a", fetchClient);
    const different = await deriveGrantsFromGateway("http://gateway.local", "Bearer token-b", fetchClient);

    expect(first?.principalId).toMatch(/^tok_[0-9a-f]{16}$/);
    expect(first?.principalId).toBe(second?.principalId ?? "");
    expect(first?.principalId).not.toBe(different?.principalId);
    expect(first?.grantedRunIds).toEqual(["run-1", "run-2"]);
    expect(first?.scopes).toEqual(["run:read"]);
  });

  test("returns null on denied/failed auth", async () => {
    const denied = await deriveGrantsFromGateway("http://gateway.local", "Bearer token", fakeFetch(403));
    expect(denied).toBeNull();

    const throwingFetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const failed = await deriveGrantsFromGateway("http://gateway.local", "Bearer token", throwingFetch);
    expect(failed).toBeNull();
  });
});
