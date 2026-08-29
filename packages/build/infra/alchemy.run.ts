import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { createHash } from "node:crypto"

const cacheDatabase = Cloudflare.D1.Database("CacheDatabase", {
  migrationsDir: "./worker/migrations"
})

const cacheBucket = Cloudflare.R2.Bucket("CacheBucket")

const maxCacheTokenBytes = 4096

const cacheTokenVerifier = Config.redacted("SMITHERS_CACHE_TOKEN").pipe(
  Config.mapOrFail((token) => {
    const value = Redacted.value(token)
    if (value.length < 16 || value.length > maxCacheTokenBytes || !/^[!-~]+$/.test(value)) {
      return Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: `SMITHERS_CACHE_TOKEN must be 16-${maxCacheTokenBytes} printable ASCII bytes with no spaces`
            })
          )
        )
      )
    }
    return Effect.succeed(Redacted.make(createHash("sha256").update(value, "utf8").digest("hex")))
  })
)

const cacheWorker = Cloudflare.Worker(
  "CacheWorker",
  Stack.useSync((stack) => ({
    main: "./worker/index.ts",
    compatibility: { date: "2026-08-14" },
    env: {
      CACHE_DATABASE: cacheDatabase,
      CACHE_BUCKET: cacheBucket,
      CACHE_TOKEN: cacheTokenVerifier
    },
    ...(stack.stage === "prod"
      ? { domain: "build.smithers.sh", workersDev: false }
      : { workersDev: true })
  }))
)

/**
 * Stage-isolated Cloudflare infrastructure for the hosted smithers build cache.
 *
 * Production owns `build.smithers.sh`; developer stages use isolated
 * `workers.dev` URLs and independently named D1 and R2 resources.
 *
 * @category infrastructure
 * @since 0.1.0
 */
export default Alchemy.Stack(
  "SmithersBuildRemoteCache",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState()
  },
  Effect.gen(function*() {
    const { stage } = yield* Alchemy.Stack
    const database = yield* cacheDatabase
    const bucket = yield* cacheBucket
    const worker = yield* cacheWorker
    return {
      stage,
      url: worker.url,
      databaseName: database.databaseName,
      bucketName: bucket.bucketName
    }
  })
)
