import {
  type ActionCache,
  type ActionCachePublication,
  canonicalJson,
  type ContentStore,
  createHandler,
  describeFailure,
  maxArtifactBodyBytes,
  maxCanonicalJsonBytes
} from "./protocol.ts"

interface CacheWorkerEnv {
  readonly CACHE_DATABASE: D1Database
  readonly CACHE_BUCKET: R2Bucket
  /** SHA-256 of the pull credential every job may hold, trusted or not. */
  readonly CACHE_READ_TOKEN: string
  /** SHA-256 of the publish credential only post-merge jobs may hold. */
  readonly CACHE_WRITE_TOKEN: string
}

interface KeyRow {
  readonly key_digest: string
}

interface EntryRow {
  readonly entry_json: string
}

interface ResultRow {
  readonly result_json: string
}

interface HealthRow {
  readonly ok: number
}

const healthObjectKey = "__smithers_build_healthcheck__"
const findMissingConcurrency = 16
const maxPublicationAttempts = 3

const digestBytes = (digest: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(digest.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16))

const sameBytes = (left: ArrayBuffer, right: Uint8Array<ArrayBuffer>): boolean => {
  const candidate = new Uint8Array(left)
  if (candidate.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < right.byteLength; index += 1) {
    difference |= (candidate[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const assertContentObject = (digest: string, object: R2Object): void => {
  if (
    object.key !== digest ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > maxArtifactBodyBytes
  ) {
    throw new Error("R2 returned an object outside the content-store invariant")
  }
  const checksum = object.checksums.sha256
  if (checksum === undefined) {
    throw new Error("R2 returned an object without a SHA-256 checksum")
  }
  if (!sameBytes(checksum, digestBytes(digest))) {
    throw new Error("R2 returned an object with a mismatched SHA-256 checksum")
  }
}

const validateStoredResult = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxCanonicalJsonBytes
  ) throw new Error("D1 returned an invalid action-cache discriminator")
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error("D1 returned an invalid action-cache discriminator")
  }
  if (canonicalJson(parsed) !== value) {
    throw new Error("D1 returned a non-canonical action-cache discriminator")
  }
  return value
}

const insertEntry = (
  database: D1Database,
  keyDigest: string,
  publication: ActionCachePublication
): Promise<KeyRow | null> =>
  database
    .prepare(
      `INSERT INTO smithers_build_cache_entry (
        key_digest,
        entry_json,
        result_json,
        created_at_ms,
        recorded_run_id,
        recorded_event_seq
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (key_digest) DO NOTHING
      RETURNING key_digest`
    )
    .bind(
      keyDigest,
      publication.body,
      publication.resultJson,
      publication.createdAtMs,
      publication.recordedRunId,
      publication.recordedEventSeq
    )
    .first<KeyRow>()

const readAndTouchStoredResult = (
  database: D1Database,
  keyDigest: string
): Promise<ResultRow | null> =>
  database
    .prepare(
      `UPDATE smithers_build_cache_entry
      SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE key_digest = ?
      RETURNING result_json`
    )
    .bind(keyDigest)
    .first<ResultRow>()

const makeActionCache = (database: D1Database): ActionCache => ({
  async get(keyDigest) {
    const row = await database
      .prepare(
        `UPDATE smithers_build_cache_entry
        SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            access_count = CASE
              WHEN access_count < 9223372036854775807 THEN access_count + 1
              ELSE access_count
            END
        WHERE key_digest = ?
        RETURNING entry_json`
      )
      .bind(keyDigest)
      .first<EntryRow>()
    return row?.entry_json ?? null
  },
  async put(keyDigest, publication) {
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      if ((await insertEntry(database, keyDigest, publication)) !== null) return "inserted"
      const stored = await readAndTouchStoredResult(database, keyDigest)
      if (stored !== null) {
        return validateStoredResult(stored.result_json) === publication.resultJson ? "identical" : "conflict"
      }
    }
    throw new Error("action-cache publication lost its row repeatedly")
  },
  async delete(keyDigest, fence) {
    const row = fence === null
      ? await database
        .prepare("DELETE FROM smithers_build_cache_entry WHERE key_digest = ? RETURNING key_digest")
        .bind(keyDigest)
        .first<KeyRow>()
      : await database
        .prepare(
          `DELETE FROM smithers_build_cache_entry
              WHERE key_digest = ?
                AND recorded_run_id = ?
                AND recorded_event_seq = ?
              RETURNING key_digest`
        )
        .bind(keyDigest, fence.runId, fence.eventSeq)
        .first<KeyRow>()
    return row !== null
  }
})

/**
 * Adapts R2 to the checksum-verifying content-store contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeContentStore = (bucket: R2Bucket): ContentStore => ({
  async get(digest) {
    const object = await bucket.get(digest)
    if (object === null) return null
    assertContentObject(digest, object)
    return { body: object.body }
  },
  async has(digest) {
    const object = await bucket.head(digest)
    if (object === null) return false
    assertContentObject(digest, object)
    return true
  },
  async put(digest, bytes) {
    const options = {
      httpMetadata: { contentType: "application/octet-stream" },
      sha256: digestBytes(digest)
    } as const
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      const object = await bucket.put(digest, bytes, {
        ...options,
        onlyIf: new Headers({ "if-none-match": "*" })
      })
      if (object !== null) {
        assertContentObject(digest, object)
        return "inserted"
      }
      const existing = await bucket.head(digest)
      if (existing === null) continue
      try {
        assertContentObject(digest, existing)
        return "present"
      } catch {
        // A conditional miss proves an object owns this digest, but an absent
        // or mismatched provider checksum means it is not CAS content. The
        // request body was already address-verified by the protocol, so an
        // unconditional write is a deterministic repair. A concurrent repair
        // writes the same bytes and checksum and is therefore harmless.
        const repaired = await bucket.put(digest, bytes, options)
        if (repaired === null) throw new Error("R2 did not return the repaired content object")
        assertContentObject(digest, repaired)
        return "inserted"
      }
    }
    throw new Error("R2 conditional publication lost its object repeatedly")
  },
  async presentDigests(digests) {
    const present = new Set<string>()
    for (let offset = 0; offset < digests.length; offset += findMissingConcurrency) {
      const batch = digests.slice(offset, offset + findMissingConcurrency)
      const objects = await Promise.all(batch.map((digest) => bucket.head(digest)))
      for (let index = 0; index < batch.length; index += 1) {
        const digest = batch[index]
        const object = objects[index]
        if (digest !== undefined && object !== null && object !== undefined) {
          assertContentObject(digest, object)
          present.add(digest)
        }
      }
    }
    return present
  }
})

const makeHealth = (database: D1Database, bucket: R2Bucket) => async (): Promise<void> => {
  const [row] = await Promise.all([
    database.prepare("SELECT 1 AS ok").first<HealthRow>(),
    bucket.head(healthObjectKey)
  ])
  if (row?.ok !== 1) throw new Error("D1 readiness check did not return its sentinel")
}

type CacheHandler = ReturnType<typeof createHandler>

let isolateHandler: CacheHandler | null = null

const handlerFor = (env: CacheWorkerEnv): CacheHandler => {
  if (isolateHandler !== null) return isolateHandler
  isolateHandler = createHandler({
    actionCache: makeActionCache(env.CACHE_DATABASE),
    contentStore: makeContentStore(env.CACHE_BUCKET),
    readTokenHash: env.CACHE_READ_TOKEN,
    writeTokenHash: env.CACHE_WRITE_TOKEN,
    health: makeHealth(env.CACHE_DATABASE, env.CACHE_BUCKET)
  })
  return isolateHandler
}

/**
 * Cloudflare Worker entry point for the hosted remote cache.
 *
 * @category runtime
 * @since 0.1.0
 */
const worker = {
  async fetch(request: Request, env: CacheWorkerEnv): Promise<Response> {
    try {
      return await handlerFor(env)(request)
    } catch (cause) {
      console.error(describeFailure(cause))
      return new Response(JSON.stringify({ error: "the cache tier failed to initialize" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      })
    }
  }
} satisfies ExportedHandler<CacheWorkerEnv>

export default worker
