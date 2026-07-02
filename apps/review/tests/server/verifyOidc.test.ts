import { beforeEach, describe, expect, test } from "bun:test";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { verifyOidc } from "../../src/server/sessions/verifyOidc.ts";
import { rsaKeypair } from "./helpers/rsaKeypair.ts";
import { serveJwks } from "./helpers/serveJwks.ts";
import { signTestJwt } from "./helpers/signTestJwt.ts";

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
