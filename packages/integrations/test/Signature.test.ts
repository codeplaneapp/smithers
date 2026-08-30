import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  computeHmacSha256Hex,
  constantTimeEqual,
  GITHUB_SIGNATURE_PREFIX,
  verifySignature
} from "../src/core/Signature.ts"

const SECRET = "shared-secret-correct"
const BODY = JSON.stringify({ branch: "main" })

const hex = (payload: string, secret: string) => computeHmacSha256Hex(payload, secret)
const base64 = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64")

describe("constantTimeEqual", () => {
  it("accepts identical bytes", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })

  // The pin: a comparison that returned early on the first differing byte
  // would leak the expected digest one byte at a time to an attacker who can
  // time the endpoint. The rejection must not depend on where the difference
  // is, so a difference in the last byte is rejected exactly like one in the
  // first, and a length mismatch is answered rather than thrown.
  it("rejects a difference in any position, including the last", () => {
    expect(constantTimeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1, 2, 9]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it("rejects a length mismatch without throwing", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true)
  })
})

describe("verifySignature", () => {
  it("accepts the GitHub sha256= hex form", () => {
    expect(
      verifySignature({
        payload: BODY,
        secret: SECRET,
        signature: `${GITHUB_SIGNATURE_PREFIX}${hex(BODY, SECRET)}`,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(true)
  })

  it("accepts a bare hex digest, which is what Linear sends", () => {
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: hex(BODY, SECRET) })).toBe(true)
  })

  it("accepts a base64 digest", () => {
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: base64(BODY, SECRET) })).toBe(true)
  })

  it("strips an optional sha256= prefix when no prefix is required", () => {
    expect(
      verifySignature({ payload: BODY, secret: SECRET, signature: `SHA256=${hex(BODY, SECRET)}` })
    ).toBe(true)
  })

  it("rejects a digest computed with a different secret", () => {
    expect(
      verifySignature({
        payload: BODY,
        secret: SECRET,
        signature: `${GITHUB_SIGNATURE_PREFIX}${hex(BODY, "shared-secret-wrong")}`,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(false)
  })

  // A near-miss is the shape a timing attack produces, so it gets its own case.
  it("rejects a digest that differs only in its final character", () => {
    const digest = hex(BODY, SECRET)
    const tampered = `${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: tampered })).toBe(false)
  })

  it("rejects a signature over different bytes", () => {
    expect(
      verifySignature({ payload: BODY, secret: SECRET, signature: hex(`${BODY} `, SECRET) })
    ).toBe(false)
  })

  it("rejects a missing, empty, or non-string signature", () => {
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: undefined })).toBe(false)
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: null })).toBe(false)
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: "" })).toBe(false)
  })

  it("rejects an empty secret", () => {
    expect(verifySignature({ payload: BODY, secret: "", signature: hex(BODY, SECRET) })).toBe(false)
  })

  it("rejects a required prefix that is absent, and an empty digest after it", () => {
    expect(
      verifySignature({ payload: BODY, secret: SECRET, signature: hex(BODY, SECRET), prefix: GITHUB_SIGNATURE_PREFIX })
    ).toBe(false)
    expect(
      verifySignature({
        payload: BODY,
        secret: SECRET,
        signature: GITHUB_SIGNATURE_PREFIX,
        prefix: GITHUB_SIGNATURE_PREFIX
      })
    ).toBe(false)
  })

  it("rejects a digest that is neither hex nor base64", () => {
    expect(verifySignature({ payload: BODY, secret: SECRET, signature: "not a digest!!" })).toBe(false)
  })

  it("verifies raw bytes, not only strings", () => {
    const bytes = new TextEncoder().encode(BODY)
    expect(verifySignature({ payload: bytes, secret: SECRET, signature: hex(BODY, SECRET) })).toBe(true)
  })
})
