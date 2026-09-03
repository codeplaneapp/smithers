import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import {
  cacheBucketOptions,
  cacheDatabaseOptions,
  cacheStackOutputs,
  cacheWorkerOptions,
  stackName
} from "./deployment.ts"

// Every option object and the stack program come from `deployment.ts`, where
// the suite executes them. This file only names the resources, which cannot
// be applied without a Cloudflare account.
const cacheDatabase = Cloudflare.D1.Database("CacheDatabase", cacheDatabaseOptions)
const cacheBucket = Cloudflare.R2.Bucket("CacheBucket", cacheBucketOptions)
const cacheWorker = Cloudflare.Worker(
  "CacheWorker",
  Stack.useSync(cacheWorkerOptions({ database: cacheDatabase, bucket: cacheBucket }))
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
