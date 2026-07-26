import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { computeHmacSha256Hex, verifySignature } from "../src/core/verifySignature.js";

const SECRET = "test-webhook-secret";
const PAYLOAD = JSON.stringify({ action: "opened", number: 42 });

function realHex(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifySignature", () => {
  test("computeHmacSha256Hex matches node crypto", () => {
    expect(computeHmacSha256Hex(PAYLOAD, SECRET)).toBe(realHex(PAYLOAD, SECRET));
  });
  test("accepts a GitHub-style sha256=<hex> signature", () => {
    const signature = `sha256=${realHex(PAYLOAD, SECRET)}`;
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature, prefix: "sha256=" })).toBe(true);
    // Default prefix stripping also handles it without an explicit prefix.
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature })).toBe(true);
  });
  test("accepts a plain hex signature (Linear style)", () => {
    const signature = realHex(PAYLOAD, SECRET);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature })).toBe(true);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: signature.toUpperCase() })).toBe(true);
  });
  test("accepts a base64 signature", () => {
    const signature = createHmac("sha256", SECRET).update(PAYLOAD).digest("base64");
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature })).toBe(true);
  });
  test("rejects a wrong secret", () => {
    const signature = `sha256=${realHex(PAYLOAD, "some-other-secret")}`;
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature, prefix: "sha256=" })).toBe(false);
  });
  test("rejects a tampered payload", () => {
    const signature = `sha256=${realHex(PAYLOAD, SECRET)}`;
    expect(verifySignature({ payload: PAYLOAD + "x", secret: SECRET, signature, prefix: "sha256=" })).toBe(false);
  });
  test("rejects missing/empty/short signatures without throwing", () => {
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: null })).toBe(false);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: undefined })).toBe(false);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: "" })).toBe(false);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: "sha256=", prefix: "sha256=" })).toBe(false);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature: "deadbeef" })).toBe(false);
  });
  test("rejects when the required prefix is absent", () => {
    const signature = realHex(PAYLOAD, SECRET);
    expect(verifySignature({ payload: PAYLOAD, secret: SECRET, signature, prefix: "sha256=" })).toBe(false);
  });
});
