/**
 * Cloudflare resource declarations for the hosted build cache.
 *
 * @since 0.1.0
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import {
  cacheBucketOptions,
  cacheDatabaseOptions,
  cacheStackOutputs,
  cacheWorkerOptions,
  credentialRequestBudget,
  findMissingBudget,
  stackName
} from "./deployment.ts"

// Every option object and the stack program come from `deployment.ts`, where
// the suite executes them. This file only names the resources, which cannot
// be applied without a Cloudflare account.
const cacheDatabase = Cloudflare.D1.Database("CacheDatabase", cacheDatabaseOptions)
const cacheBucket = Cloudflare.R2.Bucket("CacheBucket", cacheBucketOptions)
// Rate Limiting bindings have no backing resource: they live on the Worker
// alone, and the Worker keys them by the SHA-256 of the presented credential.
const requestBudget = Cloudflare.RateLimit("CACHE_REQUEST_BUDGET", credentialRequestBudget)
const probeBudget = Cloudflare.RateLimit("CACHE_FIND_MISSING_BUDGET", findMissingBudget)
const cacheWorker = Cloudflare.Worker(
  "CacheWorker",
  Stack.useSync(
    cacheWorkerOptions({
      database: cacheDatabase,
      bucket: cacheBucket,
      requestBudget,
      findMissingBudget: probeBudget
    })
  )
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
  cacheStackOutputs({ stack: Alchemy.Stack, database: cacheDatabase, bucket: cacheBucket, worker: cacheWorker })
)
