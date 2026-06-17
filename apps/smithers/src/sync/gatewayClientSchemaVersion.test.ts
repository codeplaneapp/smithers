import { describe, expect, test } from "bun:test";
import { gatewayClientSchemaVersion } from "./gatewayClientSchemaVersion";

/**
 * The persisted-collection schema version is sourced from the gateway's
 * `getSchemaSignature` RPC. The memo must hold ONLY successful resolutions: an
 * offline fallback at startup must not pin the whole app lifetime to `:offline`,
 * or a later server schema bump could never clear the persisted client replica.
 */
describe("gatewayClientSchemaVersion", () => {
  test("does not pin the offline fallback; re-attempts and adopts the server signature after recovery", async () => {
    // Gateway unreachable at startup -> durable-cache fallback for THIS attempt.
    const offline = await gatewayClientSchemaVersion(() =>
      Promise.reject(new Error("gateway unreachable")),
    );
    expect(offline).toBe("0016:offline");

    // Recovery: the next caller re-attempts (memo was dropped on failure) and
    // adopts the live server signature instead of staying stuck offline.
    const recovered = await gatewayClientSchemaVersion(() =>
      Promise.resolve({ schemaVersion: "0017", signature: "abc123" }),
    );
    expect(recovered).toBe("0017:abc123");

    // A successful resolution IS memoized: a later call returns it without
    // re-fetching (the injected fetcher here would throw if it were called).
    const cached = await gatewayClientSchemaVersion(() => {
      throw new Error("should not re-fetch after a successful resolution");
    });
    expect(cached).toBe("0017:abc123");
  });
});
