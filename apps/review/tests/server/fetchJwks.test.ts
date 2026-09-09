import { beforeEach, describe, expect, test } from "bun:test";
import { fetchJwks, JWKS_REFRESH_COOLDOWN_MS } from "../../src/server/sessions/fetchJwks.ts";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { rsaKeypair } from "./helpers/rsaKeypair.ts";

beforeEach(() => {
  jwksCache.clear();
});

describe("fetchJwks deadline", () => {
  test.each(["fetch", "body"] as const)("bounds a stalled %s, releases waiters, and allows retry", async (stage) => {
    const key = await rsaKeypair("timeout-recovery");
    const url = `https://deadline.test/${stage}`;
    const now = Date.now();
    let attempts = 0;
    let signal: AbortSignal | null | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      attempts += 1;
      signal = init?.signal;
      if (attempts === 1) {
        // Deliberately ignore abort: the deadline must release callers even
        // when an injected transport or body reader does not cooperate.
        if (stage === "fetch") await held;
        else return new Response(new ReadableStream({
          async start(controller) {
            await held;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ keys: [key.publicJwk] })));
            controller.close();
          },
        }));
      }
      return Response.json({ keys: [key.publicJwk] });
    }) as typeof fetch;
    const started = performance.now();
    try {
      const outcomes = await Promise.allSettled([
        fetchJwks(url, now, fetchImpl),
        fetchJwks(url, now + 1, fetchImpl),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(performance.now() - started).toBeLessThan(7_000);
      expect(attempts).toBe(1);
      expect(signal?.aborted).toBe(true);
      expect(jwksCache.get(url)?.inFlight).toBeUndefined();
      expect(jwksCache.get(url)?.keys).toBeUndefined();
      await expect(fetchJwks(url, now + JWKS_REFRESH_COOLDOWN_MS - 1, fetchImpl)).rejects.toThrow();
      expect(attempts).toBe(1);
      expect<unknown>(await fetchJwks(url, now + JWKS_REFRESH_COOLDOWN_MS, fetchImpl)).toEqual([key.publicJwk]);
      expect(attempts).toBe(2);
      // A late successful body from the abandoned request cannot rewrite
      // the replacement cache entry or its timestamp.
      release();
      await Bun.sleep(20);
      expect(jwksCache.get(url)?.fetchedAt).toBe(now + JWKS_REFRESH_COOLDOWN_MS);
      expect(jwksCache.get(url)?.inFlight).toBeUndefined();
    } finally {
      release();
    }
  }, 30_000);
});
