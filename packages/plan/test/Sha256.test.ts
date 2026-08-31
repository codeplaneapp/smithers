import { describe, expect, it } from "@effect/vitest"
import { digestSync } from "@smthrs/crypto"

describe("synchronous SHA-256", () => {
  it("matches FIPS and UTF-8 vectors", () => {
    expect(digestSync("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(digestSync("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(digestSync("λ")).toBe("6bb5604cb68c1e249874295f9dad38394b818646a41a813af58598b72f0c221b")
  })
})
