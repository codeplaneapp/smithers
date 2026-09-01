import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeContentStore } from "../index.ts"

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex")
const digestBytes = (digest: string): ArrayBuffer =>
  Uint8Array.from(digest.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16)).buffer

const object = (
  key: string,
  options: { readonly checksum?: ArrayBuffer; readonly body?: ReadableStream }
): R2ObjectBody =>
  ({
    body: options.body ?? new Response("artifact").body!,
    checksums: options.checksum === undefined ? {} : { sha256: options.checksum },
    key,
    size: 8
  }) as unknown as R2ObjectBody

describe("R2 content store", () => {
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    errors.mockRestore()
  })

  it("reports an object without a verified provider checksum as absent", async () => {
    const digest = digestOf("artifact")
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const legacy = object(digest, { body })
    const bucket = {
      get: async () => legacy,
      head: async () => legacy
    } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    // Refusing instead would answer 503, which clients retry rather than treat
    // as a miss, so the digest could never be republished and repaired.
    await expect(store.get(digest)).resolves.toBeNull()
    await expect(store.has(digest)).resolves.toBe(false)
    expect(cancelled).toBe(true)
    expect(String(errors.mock.calls[0]?.[0])).toContain(digest)
  })

  it("reports a checksum that does not match the content address as absent", async () => {
    const digest = digestOf("artifact")
    const corrupt = object(digest, { checksum: digestBytes("0".repeat(64)) })
    const bucket = { head: async () => corrupt } as unknown as R2Bucket

    await expect(makeContentStore(bucket).has(digest)).resolves.toBe(false)
    expect(String(errors.mock.calls[0]?.[0])).toContain("mismatched SHA-256 checksum")
  })

  it("keeps one unverifiable object from failing a whole findMissing batch", async () => {
    const good = digestOf("good")
    const bad = digestOf("bad")
    const bucket = {
      head: async (key: string) => key === good ? object(good, { checksum: digestBytes(good) }) : object(bad, {})
    } as unknown as R2Bucket

    const present = await makeContentStore(bucket).presentDigests([good, bad])

    expect([...present]).toEqual([good])
  })

  it("refuses an object whose key or size leaves the content-store invariant", async () => {
    const digest = digestOf("artifact")
    const foreign = object("0".repeat(64), { checksum: digestBytes(digest) })
    const oversized = { ...object(digest, { checksum: digestBytes(digest) }), size: -1 } as unknown as R2ObjectBody

    // A wrong key or an impossible size is a broken bucket, not a repairable
    // object: republishing the bytes would not change the answer, so this
    // stays a storage refusal rather than becoming a miss.
    await expect(makeContentStore({ head: async () => foreign } as unknown as R2Bucket).has(digest)).rejects
      .toThrow(/outside the content-store invariant/)
    await expect(makeContentStore({ get: async () => oversized } as unknown as R2Bucket).get(digest)).rejects
      .toThrow(/outside the content-store invariant/)
    await expect(
      makeContentStore({ head: async () => foreign } as unknown as R2Bucket).presentDigests([digest])
    ).rejects.toThrow(/outside the content-store invariant/)
  })

  it("probes a large findMissing batch sixteen objects at a time", async () => {
    const digests = Array.from({ length: 20 }, (_, index) => digestOf(`artifact-${index}`))
    let inFlight = 0
    let peak = 0
    const bucket = {
      head: async (key: string) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return object(key, { checksum: digestBytes(key) })
      }
    } as unknown as R2Bucket

    const present = await makeContentStore(bucket).presentDigests(digests)

    expect([...present].sort()).toEqual([...digests].sort())
    expect(peak).toBe(16)
  })

  it("closes the repair loop: an unverifiable object reads as absent, is republished, and then reads", async () => {
    const digest = digestOf("artifact")
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    let stored = object(digest, {})
    const bucket = {
      head: async () => stored,
      get: async () => stored,
      put: async (_key: string, _body: unknown, options?: R2PutOptions) => {
        if (options?.onlyIf !== undefined) return null
        stored = object(digest, { checksum: digestBytes(digest) })
        return stored
      }
    } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    expect(await store.has(digest)).toBe(false)
    expect(await store.put(digest, bytes)).toBe("inserted")
    expect(await store.has(digest)).toBe(true)
    expect(await store.get(digest)).not.toBeNull()
  })

  it("repairs an invalid object with already address-verified request bytes", async () => {
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    const digest = digestOf("artifact")
    const legacy = object(digest, {})
    const repaired = object(digest, { checksum: digestBytes(digest) })
    const puts: Array<R2PutOptions | undefined> = []
    const bucket = {
      head: async () => legacy,
      put: async (_key: string, _body: unknown, options?: R2PutOptions) => {
        puts.push(options)
        return puts.length === 1 ? null : repaired
      }
    } as unknown as R2Bucket

    await expect(makeContentStore(bucket).put(digest, bytes)).resolves.toBe("inserted")
    expect(puts).toHaveLength(2)
    expect(puts[0]?.onlyIf).toBeDefined()
    expect(puts[1]?.onlyIf).toBeUndefined()
    expect(Array.from(puts[1]?.sha256 as Uint8Array)).toEqual(Array.from(new Uint8Array(digestBytes(digest))))
  })
})
