import { beforeEach, describe, expect, test } from "bun:test";
import { JWKS_REFRESH_COOLDOWN_MS } from "../../src/server/sessions/fetchJwks.ts";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { verifyOidc } from "../../src/server/sessions/verifyOidc.ts";
import { rsaKeypair } from "./helpers/rsaKeypair.ts";
import { serveJwks } from "./helpers/serveJwks.ts";
import { serveMutableJwks } from "./helpers/serveMutableJwks.ts";
import { signTestJwt } from "./helpers/signTestJwt.ts";

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

function baseClaims(exp: number) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: "smithers-review",
    exp,
    repository: "octo/widgets",
  };
}

beforeEach(() => {
  jwksCache.clear();
});

describe("verifyOidc", () => {
  test("uses valid RS256 signing keys from a mixed JWKS", async () => {
    const rsa = await rsaKeypair("kid-mixed-rsa");
    const rsaWithoutAlg = { ...rsa.publicJwk };
    delete rsaWithoutAlg.alg;
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const ecJwk = await crypto.subtle.exportKey("jwk", ec.publicKey);
    const jwks = serveMutableJwks([
      { ...ecJwk, kid: "kid-mixed-ec", alg: "ES256", use: "sig" },
      {
        ...rsa.publicJwk,
        kid: "kid-mixed-encryption",
        alg: "RSA-OAEP-256",
        use: "enc",
      },
      rsaWithoutAlg,
    ]);
    const now = Date.now();
    try {
      const token = await signTestJwt(rsa, baseClaims(Math.floor(now / 1000) + 600));
      expect((await verifyOidc(token, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);
    } finally {
      jwks.stop();
    }
  });

  test("ignores a valid RS512 signing key in a mixed JWKS", async () => {
    const rs256 = await rsaKeypair("kid-mixed-rs256");
    const rs512 = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-512",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rs512Jwk = await crypto.subtle.exportKey("jwk", rs512.publicKey);
    const jwks = serveMutableJwks([{ ...rs512Jwk, kid: "kid-mixed-rs512", alg: "RS512", use: "sig" }, rs256.publicJwk]);
    const now = Date.now();
    try {
      const token = await signTestJwt(rs256, baseClaims(Math.floor(now / 1000) + 600));
      expect((await verifyOidc(token, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);
    } finally {
      jwks.stop();
    }
  });

  test("refreshes a warm JWKS when a valid rotated kid appears within the cache TTL", async () => {
    const keyA = await rsaKeypair("kid-a");
    const keyB = await rsaKeypair("kid-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(Math.floor(now / 1000) + 600));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
      const tokenB = await signTestJwt(keyB, baseClaims(Math.floor(now / 1000) + 600));
      expect((await verifyOidc(tokenB, jwks.url, now + 1)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("coalesces concurrent refreshes for the same rotated kid", async () => {
    const keyA = await rsaKeypair("kid-concurrent-a");
    const keyB = await rsaKeypair("kid-concurrent-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(Math.floor(now / 1000) + 600));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
      jwks.setDelay(50);
      const tokenB = await signTestJwt(keyB, baseClaims(Math.floor(now / 1000) + 600));
      const outcomes = await Promise.all([
        verifyOidc(tokenB, jwks.url, now + 1),
        verifyOidc(tokenB, jwks.url, now + 1),
        verifyOidc(tokenB, jwks.url, now + 1),
      ]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("throttles bogus kid refreshes and accepts a later rotation after cooldown", async () => {
    const keyA = await rsaKeypair("kid-cooldown-a");
    const keyB = await rsaKeypair("kid-cooldown-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 600;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      const bogusOne = await signTestJwt(keyB, baseClaims(exp), { kid: "bogus-one" });
      const bogusTwo = await signTestJwt(keyB, baseClaims(exp), { kid: "bogus-two" });
      expect(await verifyOidc(bogusOne, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(jwks.requestCount).toBe(2);
      expect(await verifyOidc(bogusTwo, jwks.url, now + 2)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(jwks.requestCount).toBe(2);

      jwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      expect((await verifyOidc(tokenB, jwks.url, now + JWKS_REFRESH_COOLDOWN_MS + 2)).ok).toBe(true);
      expect(jwks.requestCount).toBe(3);
    } finally {
      jwks.stop();
    }
  });

  test("backs off a cold inadmissible JWKS and recovers at the cooldown boundary", async () => {
    const key = await rsaKeypair("kid-cold-backoff");
    const jwks = serveMutableJwks([{ ...key.publicJwk, n: "***" }]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await verifyOidc(token, jwks.url, now + attempt)).toEqual({
          ok: false,
          reason: "unknown-key",
        });
      }
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([key.publicJwk]);
      expect((await verifyOidc(token, jwks.url, now + JWKS_REFRESH_COOLDOWN_MS)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("backs off an expired unknown-kid refresh and recovers at the cooldown boundary", async () => {
    const keyA = await rsaKeypair("kid-expired-unknown-a");
    const keyB = await rsaKeypair("kid-expired-unknown-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 3600;
    const expiredAt = now + JWKS_CACHE_TTL_MS + 1;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setResponse({ keys: [{ ...keyB.publicJwk, alg: 42 }] });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await verifyOidc(tokenB, jwks.url, expiredAt + attempt)).toEqual({
          ok: false,
          reason: "unknown-key",
        });
      }
      expect(jwks.requestCount).toBe(2);

      jwks.setKeys([keyA.publicJwk, keyB.publicJwk]);
      expect((await verifyOidc(tokenB, jwks.url, expiredAt + JWKS_REFRESH_COOLDOWN_MS)).ok).toBe(true);
      expect(jwks.requestCount).toBe(3);
    } finally {
      jwks.stop();
    }
  });

  test("backs off an expired known-kid refresh and recovers at the cooldown boundary", async () => {
    const key = await rsaKeypair("kid-expired-known");
    const jwks = serveMutableJwks([key.publicJwk]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    const expiredAt = now + JWKS_CACHE_TTL_MS + 1;
    try {
      expect((await verifyOidc(token, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setResponse({ keys: [{ ...key.publicJwk, alg: 42 }] });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await verifyOidc(token, jwks.url, expiredAt + attempt)).ok).toBe(true);
      }
      expect(jwks.requestCount).toBe(2);

      jwks.setKeys([key.publicJwk]);
      expect((await verifyOidc(token, jwks.url, expiredAt + JWKS_REFRESH_COOLDOWN_MS)).ok).toBe(true);
      expect(jwks.requestCount).toBe(3);
    } finally {
      jwks.stop();
    }
  });

  test("backs off and tags a cached non-200 refresh failure", async () => {
    const key = await rsaKeypair("kid-http-backoff");
    const jwks = serveMutableJwks([]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    try {
      jwks.setResponse({ error: "unavailable" }, 503);
      expect(await verifyOidc(token, jwks.url, now)).toEqual({
        ok: false,
        reason: "jwks-unavailable",
      });
      expect(await verifyOidc(token, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "jwks-unavailable",
      });
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([key.publicJwk]);
      expect((await verifyOidc(token, jwks.url, now + JWKS_REFRESH_COOLDOWN_MS)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("backs off and tags a cached malformed-JSON refresh failure", async () => {
    const key = await rsaKeypair("kid-json-backoff");
    const jwks = serveMutableJwks([]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    try {
      jwks.setRawJson("{");
      expect(await verifyOidc(token, jwks.url, now)).toEqual({
        ok: false,
        reason: "jwks-unavailable",
      });
      expect(await verifyOidc(token, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "jwks-unavailable",
      });
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([key.publicJwk]);
      expect((await verifyOidc(token, jwks.url, now + JWKS_REFRESH_COOLDOWN_MS)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("backs off and tags a cached real fetch rejection", async () => {
    const key = await rsaKeypair("kid-fetch-backoff");
    const jwks = serveMutableJwks([]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    const url = jwks.url;
    jwks.stop();
    let attempts = 0;
    const countedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      attempts += 1;
      return fetch(input, init);
    }) as typeof fetch;

    expect(await verifyOidc(token, url, now, countedFetch)).toEqual({
      ok: false,
      reason: "jwks-unavailable",
    });
    expect(await verifyOidc(token, url, now + 1, countedFetch)).toEqual({
      ok: false,
      reason: "jwks-unavailable",
    });
    expect(attempts).toBe(1);
  });

  test("keeps refresh backoff URL-scoped and clears it with the cache", async () => {
    const key = await rsaKeypair("kid-backoff-isolation");
    const backedOff = serveMutableJwks([{ ...key.publicJwk, n: "***" }]);
    const healthy = serveMutableJwks([key.publicJwk]);
    const now = Date.now();
    const token = await signTestJwt(key, baseClaims(Math.floor(now / 1000) + 3600));
    try {
      expect(await verifyOidc(token, backedOff.url, now)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(backedOff.requestCount).toBe(1);

      expect((await verifyOidc(token, healthy.url, now + 1)).ok).toBe(true);
      expect(healthy.requestCount).toBe(1);

      backedOff.setKeys([key.publicJwk]);
      expect(await verifyOidc(token, backedOff.url, now + 2)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(backedOff.requestCount).toBe(1);

      jwksCache.clear();
      expect((await verifyOidc(token, backedOff.url, now + 3)).ok).toBe(true);
      expect(backedOff.requestCount).toBe(2);
    } finally {
      backedOff.stop();
      healthy.stop();
    }
  });

  test("does not fetch JWKS for a missing, empty, or malformed kid", async () => {
    const keypair = await rsaKeypair("kid-invalid-header");
    const jwks = serveMutableJwks([keypair.publicJwk]);
    const now = Date.now();
    const claims = baseClaims(Math.floor(now / 1000) + 600);
    try {
      const tokens = await Promise.all([
        signTestJwt(keypair, claims, { kid: undefined }),
        signTestJwt(keypair, claims, { kid: "" }),
        signTestJwt(keypair, claims, { kid: 42 }),
      ]);
      for (const token of tokens) {
        expect(await verifyOidc(token, jwks.url, now)).toEqual({
          ok: false,
          reason: "unknown-key",
        });
      }
      expect(jwks.requestCount).toBe(0);
    } finally {
      jwks.stop();
    }
  });

  test("retains last-good keys after a malformed refresh", async () => {
    const keyA = await rsaKeypair("kid-malformed-a");
    const keyB = await rsaKeypair("kid-malformed-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 600;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setResponse({ keys: [{ ...keyB.publicJwk, alg: 42 }] });
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      expect(await verifyOidc(tokenB, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(jwks.requestCount).toBe(2);
      expect((await verifyOidc(tokenA, jwks.url, now + 2)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("retains last-good keys after an incompatible-algorithm-only refresh", async () => {
    const keyA = await rsaKeypair("kid-unusable-a");
    const keyB = await rsaKeypair("kid-unusable-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 600;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([
        {
          ...keyB.publicJwk,
          alg: "ES256",
          use: "sig",
          n: "not-usable",
        },
      ]);
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      expect(await verifyOidc(tokenB, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(jwks.requestCount).toBe(2);

      expect((await verifyOidc(tokenA, jwks.url, now + 2)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("retains last-good keys after an unimportable RS256 signing-key refresh", async () => {
    const keyA = await rsaKeypair("kid-unimportable-a");
    const keyB = await rsaKeypair("kid-unimportable-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 600;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setKeys([{ ...keyB.publicJwk, alg: "RS256", n: "***" }]);
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      expect(await verifyOidc(tokenB, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "unknown-key",
      });
      expect(jwks.requestCount).toBe(2);

      expect((await verifyOidc(tokenA, jwks.url, now + 2)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("retains last-good keys after a failed refresh", async () => {
    const keyA = await rsaKeypair("kid-failed-a");
    const keyB = await rsaKeypair("kid-failed-b");
    const jwks = serveMutableJwks([keyA.publicJwk]);
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 600;
    try {
      const tokenA = await signTestJwt(keyA, baseClaims(exp));
      expect((await verifyOidc(tokenA, jwks.url, now)).ok).toBe(true);
      expect(jwks.requestCount).toBe(1);

      jwks.setResponse({ error: "unavailable" }, 503);
      const tokenB = await signTestJwt(keyB, baseClaims(exp));
      // The failed miss refresh cannot rule keyB's kid out, so it reports the
      // outage rather than claiming an unknown key.
      expect(await verifyOidc(tokenB, jwks.url, now + 1)).toEqual({
        ok: false,
        reason: "jwks-unavailable",
      });
      expect(jwks.requestCount).toBe(2);
      expect((await verifyOidc(tokenA, jwks.url, now + 2)).ok).toBe(true);
      expect(jwks.requestCount).toBe(2);
    } finally {
      jwks.stop();
    }
  });

  test("rejects a single JWKS key when the token kid differs", async () => {
    const keypair = await rsaKeypair("token-kid");
    const publicJwk = { ...keypair.publicJwk, kid: "jwks-kid" };
    const jwks = serveJwks([publicJwk]);
    try {
      const token = await signTestJwt(keypair, baseClaims(Math.floor(Date.now() / 1000) + 600));
      const outcome = await verifyOidc(token, jwks.url, Date.now());

      expect(outcome).toEqual({ ok: false, reason: "unknown-key" });
    } finally {
      jwks.stop();
    }
  });

  test("rejects a token with nbf in the future", async () => {
    const keypair = await rsaKeypair("kid-nbf");
    const jwks = serveJwks([keypair.publicJwk]);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await signTestJwt(keypair, { ...baseClaims(nowSec + 600), nbf: nowSec + 300 });
      const outcome = await verifyOidc(token, jwks.url, Date.now());

      expect(outcome).toEqual({ ok: false, reason: "not-yet-valid" });
    } finally {
      jwks.stop();
    }
  });

  test("rejects a token with iat in the future", async () => {
    const keypair = await rsaKeypair("kid-iat");
    const jwks = serveJwks([keypair.publicJwk]);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await signTestJwt(keypair, { ...baseClaims(nowSec + 600), iat: nowSec + 300 });
      const outcome = await verifyOidc(token, jwks.url, Date.now());

      expect(outcome).toEqual({ ok: false, reason: "not-yet-valid" });
    } finally {
      jwks.stop();
    }
  });

  test("allows nbf/iat within the clock-skew window", async () => {
    const keypair = await rsaKeypair("kid-skew");
    const jwks = serveJwks([keypair.publicJwk]);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await signTestJwt(keypair, {
        ...baseClaims(nowSec + 600),
        nbf: nowSec + 30,
        iat: nowSec + 30,
      });
      const outcome = await verifyOidc(token, jwks.url, Date.now());

      expect(outcome.ok).toBe(true);
    } finally {
      jwks.stop();
    }
  });
});
