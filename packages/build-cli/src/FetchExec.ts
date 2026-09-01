/**
 * Package-mode planning and execution for digest-pinned `S.Fetch` targets.
 *
 * Planning resolves the single declared output against the declaring package
 * and records the network capability that is intrinsic to a fetch. Execution
 * retrieves bytes through Effect's Node `HttpClient`, verifies the declared
 * sha256 before touching the workspace, and publishes the verified file by a
 * same-directory atomic rename. CAS capture and replay remain owned by the
 * shared package executor.
 *
 * @since 0.1.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as FetchTarget from "@smthrs/targets/Fetch"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createHash, randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Diagnostic from "./Diagnostic.ts"

/**
 * The network policy intrinsic to every `S.Fetch` declaration.
 *
 * @category policies
 * @since 0.1.0
 */
export const sandbox = { network: true } as const

/**
 * A typed fetch failure suitable for CLI diagnostics and direct callers.
 *
 * @category errors
 * @since 0.1.0
 */
export class FetchError extends Error {
  readonly _tag = "smithers-build/FetchError"
  readonly code:
    | "invalid_output"
    | "request_failed"
    | "unexpected_status"
    | "digest_mismatch"
    | "write_failed"
    | "body_too_large"
  readonly expectedSha256: string | undefined
  readonly actualSha256: string | undefined

  /**
   * Constructs a fetch failure without retaining response bytes or secrets.
   *
   * @since 0.1.0
   */
  constructor(
    code:
      | "invalid_output"
      | "request_failed"
      | "unexpected_status"
      | "digest_mismatch"
      | "write_failed"
      | "body_too_large",
    message: string,
    expectedSha256?: string,
    actualSha256?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "FetchError"
    this.code = code
    this.expectedSha256 = expectedSha256
    this.actualSha256 = actualSha256
  }
}

/**
 * The fields a Fetch target contributes to the shared package plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly outFiles: ReadonlyArray<string>
  readonly sandbox: typeof sandbox
  readonly refusal?: string | undefined
}

/**
 * Resolves and revalidates a Fetch output at the workspace boundary.
 *
 * The constructor already applies the declared-output law relative to its
 * package. Planning applies the same law again with the actual package path,
 * and separately rejects `//` because Fetch outputs are package-relative,
 * never workspace-root aliases.
 *
 * @category planning
 * @since 0.1.0
 */
export const planAttrs = (options: {
  readonly packagePath: string
  readonly attrs: FetchTarget.FetchAttrs
}): Plan => {
  const attrs = options.attrs
  if (attrs.out.startsWith("//")) {
    return {
      outFiles: [],
      sandbox,
      refusal: `Fetch output ${JSON.stringify(attrs.out)} must be package-relative`
    }
  }
  const failure = Target.declaredOutputsFailure({ cwd: options.packagePath, paths: [attrs.out] })
  if (failure !== undefined) return { outFiles: [], sandbox, refusal: `Fetch ${failure}` }
  try {
    return { outFiles: [Input.resolvePath(options.packagePath, attrs.out)], sandbox }
  } catch (cause) {
    return {
      outFiles: [],
      sandbox,
      refusal: `Fetch output is invalid: ${Diagnostic.describe(cause)}`
    }
  }
}

/**
 * Plans a validated Fetch declaration from its target metadata.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = (options: {
  readonly packagePath: string
  readonly target: Target.AnyTarget
}): Plan => planAttrs({ packagePath: options.packagePath, attrs: FetchTarget.fetchAttrsOf(options.target) })

/**
 * The most specific readable text in a rejected value's own `cause` chain.
 *
 * Effect's `HttpClientError` keeps its `message` on the prototype, so
 * {@link Diagnostic.message} — which reads own data properties only, on
 * purpose — sees nothing on the outermost value and would report every
 * transport failure with the same generic fallback. The underlying Node error
 * one or two `cause` hops down does carry an own `message`
 * (`connect ECONNREFUSED …`), so the walk recovers the actual reason without
 * ever invoking an accessor.
 */
const transportReason = (cause: unknown, fallback: string): string => {
  let current = cause
  for (let hop = 0; hop < 4; hop += 1) {
    const rendered = Diagnostic.message(current, "")
    if (rendered !== "") return rendered
    if (typeof current !== "object" || current === null || NodeUtil.isProxy(current)) break
    const descriptor = Object.getOwnPropertyDescriptor(current, "cause")
    if (descriptor === undefined || !("value" in descriptor)) break
    current = descriptor.value
  }
  return fallback
}

/**
 * Largest response body one `S.Fetch` will hold, in bytes.
 *
 * A fetch used to call `arrayBuffer` with no bound and no deadline of its own,
 * so a large or endless chunked response exhausted memory or hung until an
 * optional caller-supplied signal fired — and a declared Fetch may pass none.
 * The body is measured as it arrives and abandoned the moment it crosses this
 * line.
 *
 * @category limits
 * @since 0.1.0
 */
export const maximumFetchBytes = 512 * 1024 * 1024

/**
 * How long one fetch may take, in milliseconds, when the caller passed no
 * signal of its own.
 *
 * @category limits
 * @since 0.1.0
 */
export const fetchDeadlineMs = 30 * 60 * 1000

/**
 * Renders a URL without its credentials.
 *
 * The accepted grammar admits userinfo and a query, so a signed S3 URL or a
 * `https://user:token@host/...` form used to land verbatim in CLI output, the
 * reporter's stream, and every cached diagnostic. Only the origin and path
 * survive here; the full value stays in the failure's `cause`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const redactUrl = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "<unparsable url>"
  }
  const credentials = parsed.username !== "" || parsed.password !== ""
  const query = parsed.search !== "" || parsed.hash !== ""
  return `${parsed.protocol}//${credentials ? "<redacted>@" : ""}${parsed.host}${parsed.pathname}` +
    `${query ? "?<redacted>" : ""}`
}

const downloadedBytes = async (
  url: string,
  signal: AbortSignal | undefined
): Promise<Uint8Array> => {
  const safeUrl = redactUrl(url)
  const effect = Effect.scoped(Effect.gen(function*() {
    const transport = yield* HttpClient.HttpClient
    const client = HttpClient.followRedirects(transport)
    const response = yield* client.execute(HttpClientRequest.get(url))
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new FetchError("unexpected_status", `Fetch request for ${safeUrl} answered HTTP ${response.status}`)
      )
    }
    const declared = response.headers["content-length"]
    if (declared !== undefined && /^\d+$/.test(declared)) {
      const declaredBytes = Number(declared)
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > maximumFetchBytes) {
        return yield* Effect.fail(
          new FetchError(
            "body_too_large",
            `Fetch response for ${safeUrl} declares ${declaredBytes} bytes, over the ${maximumFetchBytes} limit`
          )
        )
      }
    }
    const chunks: Array<Uint8Array> = []
    let received = 0
    yield* Stream.runForEach(response.stream, (chunk: Uint8Array) =>
      Effect.suspend(() => {
        received += chunk.byteLength
        if (received > maximumFetchBytes) {
          return Effect.fail(
            new FetchError(
              "body_too_large",
              `Fetch response for ${safeUrl} exceeded the ${maximumFetchBytes} byte limit`
            )
          )
        }
        chunks.push(new Uint8Array(chunk))
        return Effect.void
      }))
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  })).pipe(
    Effect.provide(NodeHttpClient.layerUndici),
    // A declared Fetch may carry no signal at all, so the request owns a
    // deadline of its own rather than trusting the caller to interrupt it.
    Effect.timeoutOrElse({
      duration: fetchDeadlineMs,
      orElse: () => Effect.fail(new FetchError("request_failed", `Fetch request for ${safeUrl} did not finish in time`))
    })
  )
  const exit = await Effect.runPromiseExit(effect, { signal })
  if (Exit.isSuccess(exit)) return exit.value
  const cause: unknown = Cause.squash(exit.cause)
  if (cause instanceof FetchError) throw cause
  throw new FetchError(
    "request_failed",
    `Fetch request failed for ${safeUrl}: ${transportReason(cause, "HTTP transport failed")}`,
    undefined,
    undefined,
    { cause }
  )
}

const atomicWrite = async (destination: string, bytes: Uint8Array): Promise<void> => {
  const temporary = `${destination}.smthrs-fetch-${process.pid}-${randomBytes(6).toString("hex")}`
  try {
    await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
    const handle = await Fs.open(temporary, "wx", 0o644)
    try {
      await handle.writeFile(bytes)
      // `open`'s mode is masked by the process umask, but a CAS restore of the
      // same file chmods it to 0o644. Setting the mode explicitly keeps a
      // fresh download and a restored one identical in metadata as well as
      // bytes, whatever umask the run inherited.
      await handle.chmod(0o644)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await Fs.rename(temporary, destination)
  } catch (cause) {
    await Fs.rm(temporary, { force: true }).catch(() => undefined)
    throw new FetchError(
      "write_failed",
      `Fetch could not publish ${destination}: ${Diagnostic.describe(cause)}`,
      undefined,
      undefined,
      { cause }
    )
  }
}

/**
 * The successful result logged by the package executor.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result {
  readonly bytes: number
  readonly sha256: string
}

/**
 * Downloads, verifies, and atomically publishes one Fetch target.
 *
 * Digest verification is deliberately complete before `atomicWrite` is
 * called. A mismatch therefore cannot create a destination or disturb an
 * existing one, and the typed failure carries both hashes.
 *
 * @category execution
 * @since 0.1.0
 */
export const execute = async (options: {
  readonly root: string
  readonly target: Target.AnyTarget
  readonly outFile: string
  readonly signal?: AbortSignal | undefined
}): Promise<Result> => {
  const attrs = FetchTarget.fetchAttrsOf(options.target)
  const bytes = await downloadedBytes(attrs.url, options.signal)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== attrs.sha256) {
    throw new FetchError(
      "digest_mismatch",
      `Fetch sha256 mismatch: expected ${attrs.sha256}, actual ${actual}`,
      attrs.sha256,
      actual
    )
  }
  const destination = NodePath.join(options.root, ...options.outFile.split("/"))
  await atomicWrite(destination, bytes)
  return { bytes: bytes.byteLength, sha256: actual }
}
