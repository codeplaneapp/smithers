import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
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
  it("refuses reads and presence claims without a verified provider checksum", async () => {
    const digest = digestOf("artifact")
    const legacy = object(digest, {})
    const bucket = {
      get: async () => legacy,
      head: async () => legacy
    } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    await expect(store.get(digest)).rejects.toThrow(/without a SHA-256 checksum/)
    await expect(store.has(digest)).rejects.toThrow(/without a SHA-256 checksum/)
  })

  it("refuses a provider checksum that does not match the content address", async () => {
    const digest = digestOf("artifact")
    const corrupt = object(digest, { checksum: digestBytes("0".repeat(64)) })
    const bucket = { head: async () => corrupt } as unknown as R2Bucket

    await expect(makeContentStore(bucket).has(digest)).rejects.toThrow(/mismatched SHA-256 checksum/)
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
