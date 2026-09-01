import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import * as Effect from "effect/Effect"
import { cacheTokenVerifier, retentionCron, stackName, workerStageOptions } from "./deployment.ts"

const cacheDatabase = Cloudflare.D1.Database("CacheDatabase", {
  migrationsDir: "./worker/migrations"
})

const cacheBucket = Cloudflare.R2.Bucket("CacheBucket")

const cacheWorker = Cloudflare.Worker(
  "CacheWorker",
  Stack.useSync((stack) => ({
    main: "./worker/index.ts",
    compatibility: { date: "2026-08-14" },
    // The Worker's `scheduled` handler prunes entries past the retention
    // window; without this trigger the store grows until D1 refuses writes.
    crons: [retentionCron],
    env: {
      CACHE_DATABASE: cacheDatabase,
      CACHE_BUCKET: cacheBucket,
      CACHE_READ_TOKEN: cacheTokenVerifier("SMITHERS_CACHE_READ_TOKEN"),
      CACHE_WRITE_TOKEN: cacheTokenVerifier("SMITHERS_CACHE_WRITE_TOKEN")
    },
    ...workerStageOptions(stack.stage)
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
  stackName,
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
