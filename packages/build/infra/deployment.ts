/**
 * Deployment policy for the hosted remote cache, separated from the Alchemy
 * resource graph so every rule it encodes can be exercised directly.
 *
 * @since 0.1.0
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { createHash } from "node:crypto"

/**
 * The Alchemy stack name, which is also the state directory redaction walks.
 *
 * @category constants
 * @since 0.1.0
 */
export const stackName = "SmithersBuildRemoteCache"

/**
 * The shortest cache credential a deployment accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const minCacheTokenBytes = 16

/**
 * The longest cache credential a deployment accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxCacheTokenBytes = 4096

/**
 * When the Worker's scheduled retention sweep runs.
 *
 * @category constants
 * @since 0.1.0
 */
export const retentionCron = "17 3 * * *"

/**
 * How long a published artifact survives in R2.
 *
 * R2 lifecycle rules measure an object's age from its upload, not from its
 * last read, so this cannot be the same window the D1 sweep applies to entries
 * (that one is last-access based). It is deliberately three times longer, so
 * an entry that is still being read normally outlives its artifacts' upload
 * age only in the tail. When it does not, the reference dangles and `GET
 * /cas/{digest}` answers 404, which `@smthrs/artifacts` raises as
 * `ArtifactMissing` and the engine's step boundary turns into a real
 * execution: a cache miss, never a corrupt restore.
 *
 * @category constants
 * @since 0.1.0
 */
export const artifactRetentionDays = 90

/**
 * How long an incomplete multipart upload survives in R2.
 *
 * An abandoned upload is billed storage that no request can ever read, so it
 * is discarded well inside the artifact window.
 *
 * @category constants
 * @since 0.1.0
 */
export const abandonedUploadRetentionDays = 1

const secondsPerDay = 24 * 60 * 60

/**
 * The bucket lifecycle the deployment applies to published artifacts.
 *
 * Declared here rather than inline in the resource graph so the retention
 * policy is exercised by the same suite that covers the rest of deployment
 * policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const artifactLifecycleRules = [
  {
    id: "expire-cache-artifacts",
    enabled: true,
    deleteObjectsTransition: {
      condition: { type: "Age", maxAge: artifactRetentionDays * secondsPerDay }
    }
  },
  {
    id: "abort-abandoned-uploads",
    enabled: true,
    abortMultipartUploadsTransition: {
      condition: { type: "Age", maxAge: abandonedUploadRetentionDays * secondsPerDay }
    }
  }
] as const satisfies ReadonlyArray<{
  readonly id: string
  readonly enabled: boolean
  readonly deleteObjectsTransition?: { readonly condition: { readonly type: "Age"; readonly maxAge: number } }
  readonly abortMultipartUploadsTransition?: {
    readonly condition: { readonly type: "Age"; readonly maxAge: number }
  }
}>

const printableAscii = /^[!-~]+$/

/**
 * The name of one cache credential.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheTokenName = "SMITHERS_CACHE_READ_TOKEN" | "SMITHERS_CACHE_WRITE_TOKEN"

/**
 * Turns one cache credential into the verifier the Worker receives.
 *
 * The Worker never holds a bearer value: it compares the SHA-256 of the token
 * a request presents against this digest, so Alchemy state and the Cloudflare
 * secret carry a one-way verifier rather than a usable credential.
 *
 * @throws A `TypeError` naming the offending variable when the value is
 * shorter than {@link minCacheTokenBytes}, longer than
 * {@link maxCacheTokenBytes}, or contains anything but printable
 * space-free ASCII.
 * @category constructors
 * @since 0.1.0
 */
export const cacheTokenDigest = (name: CacheTokenName, value: string): string => {
  if (value.length < minCacheTokenBytes || value.length > maxCacheTokenBytes || !printableAscii.test(value)) {
    throw new TypeError(
      `${name} must be ${minCacheTokenBytes}-${maxCacheTokenBytes} printable ASCII bytes with no spaces`
    )
  }
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/**
 * Reads one cache credential and hands the Worker its digest.
 *
 * Both credentials are required at deploy time. A Worker that received only
 * one of them would answer every request from whichever half was configured,
 * which is the single-credential posture this split exists to end, so a
 * missing secret fails the deployment instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cacheTokenVerifier = (name: CacheTokenName): Config.Config<Redacted.Redacted<string>> =>
  Config.redacted(name).pipe(
    Config.mapOrFail((token) => {
      try {
        return Effect.succeed(Redacted.make(cacheTokenDigest(name, Redacted.value(token))))
      } catch (cause) {
        return Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: cause instanceof TypeError ? cause.message : `${name} is invalid`
              })
            )
          )
        )
      }
    })
  )

/**
 * The stage-dependent half of the Worker's configuration.
 *
 * Production claims the custom domain and refuses a `workers.dev` URL, so the
 * service has exactly one public address. Every other stage is the reverse:
 * an isolated `workers.dev` URL and no claim on the production domain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const workerStageOptions = (
  stage: string
): { readonly domain: string; readonly workersDev: false } | { readonly workersDev: true } =>
  stage === "prod" ? { domain: "build.smithers.sh", workersDev: false } : { workersDev: true }
