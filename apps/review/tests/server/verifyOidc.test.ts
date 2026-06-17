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
});
