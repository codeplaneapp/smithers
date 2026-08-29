/**
 * Browser `Jj` layer.
 *
 * jj is a native binary, but jj-lib compiles to wasm32-wasip1: the
 * `flows_jj.wasm` reactor (built by `crates/flows-jj`, shipped in this
 * package's `wasm/` directory) exposes the six `Jj` contract operations over a
 * tiny JSON ABI, and runs against the {@link WasiPreview1} host shim over the
 * same virtual-filesystem slice `BrowserFileSystem` mounts on. {@link layer}
 * wires the two together.
 *
 * The module is an argument, never a fetch: the page decides how the bytes
 * arrive (bundler asset, `fetch` + `WebAssembly.compileStreaming`, cache), the
 * same way it decides which ZenFS backend is mounted. Likewise persistence is
 * the page's concern — with an async-mirror ZenFS mount, call the mount's
 * `sync` after operations that must survive a reload; this layer does not own
 * the mount.
 *
 * Hosts without a wasm module keep {@link layerUnsupported}: the service stays
 * present and every operation fails `not_installed` in the error channel — an
 * absent capability is a capability with an answer, never a missing tag.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { Jj, JjError, JjErrorCode } from "../Jj.ts"
import type { SyncFsLike } from "./WasiFs.ts"
import * as WasiPreview1 from "./WasiPreview1.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * The exports the frozen `flows_jj.wasm` ABI guarantees: a reactor
 * initializer, an allocator pair, and one call entrypoint taking UTF-8 JSON
 * and returning `(ptr << 32) | len` packed into a `u64`.
 */
interface AbiExports {
  readonly memory: WebAssembly.Memory
  readonly _initialize: () => void
  readonly flows_jj_alloc: (size: number) => number
  readonly flows_jj_free: (ptr: number, size: number) => void
  readonly flows_jj_call: (ptr: number, len: number) => bigint
}

const REQUIRED_EXPORTS = ["memory", "_initialize", "flows_jj_alloc", "flows_jj_free", "flows_jj_call"] as const

/**
 * What the browser `Jj` layer needs to run jj in a page: the wasm reactor, and
 * the synchronous filesystem the repository lives on.
 *
 * The layer never fetches the module itself — a page decides when and how to
 * load bytes, and passing an already-compiled `WebAssembly.Module` lets it
 * share one across layers.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BrowserJjOptions {
  /**
   * The `flows_jj.wasm` reactor, precompiled or as raw bytes. The layer never
   * fetches; hand it the module the page already loaded.
   */
  readonly wasm: WebAssembly.Module | BufferSource
  /**
   * The synchronous filesystem the repository lives on — ZenFS's sync surface
   * in a page, `node:fs` behind a rooted adapter in tests. The slice's
   * namespace is the wasm module's namespace: its `"/"` is preopened as WASI
   * `"/"`.
   */
  readonly fs: SyncFsLike
  /**
   * The jj workspace root inside the slice namespace, defaulting to `"/"`.
   * Prefer a dedicated directory (`"/repo"`) that already exists so the
   * repository's `.jj` does not share the mount root with unrelated state.
   */
  readonly root?: string
  /** Receives anything jj-lib writes to stdout. Unset drops it. */
  readonly onStdout?: (text: string) => void
  /** Receives anything jj-lib writes to stderr — Rust panics arrive here. */
  readonly onStderr?: (text: string) => void
}

const isJjErrorCode = Schema.is(JjErrorCode)

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

type OkPayload = Record<string, unknown>

/**
 * One serialized ABI exchange: encode the request into wasm memory through the
 * module's allocator, call, copy the response out, and free both buffers (the
 * host owns freeing the request buffer too — the module must not).
 */
const exchange = (abi: AbiExports, request: Record<string, unknown>): string => {
  const req = encoder.encode(JSON.stringify(request))
  const reqPtr = abi.flows_jj_alloc(req.length)
  try {
    new Uint8Array(abi.memory.buffer, reqPtr, req.length).set(req)
    const packed = BigInt.asUintN(64, abi.flows_jj_call(reqPtr, req.length))
    const resPtr = Number(packed >> 32n)
    const resLen = Number(packed & 0xFFFF_FFFFn)
    const response = new Uint8Array(abi.memory.buffer, resPtr, resLen).slice()
    abi.flows_jj_free(resPtr, resLen)
    return decoder.decode(response)
  } finally {
    // The instance survives a trapped call (it stays cached and reused), so
    // the request buffer must be freed on the error path too — otherwise
    // every trap leaks its request bytes into the instance's allocator.
    try {
      abi.flows_jj_free(reqPtr, req.length)
    } catch {
      // Freeing after a trap can itself trap; the original failure wins.
    }
  }
}

/**
 * `{"ok":…}` or `{"err":…}` decoded onto the frozen `JjError` codes. An error
 * code outside the frozen set, or a response that is neither shape, degrades
 * to `unknown` — the ABI partner is pinned in-repo, so either is a bug worth
 * surfacing, not worth crashing over.
 */
const decodeResponse = (method: string, text: string): Effect.Effect<OkPayload, JjError> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return Effect.fail(new JjError({ code: "unknown", message: `jj ${method}: malformed ABI response: ${text}` }))
  }
  if (isRecord(parsed) && "err" in parsed) {
    const err: unknown = parsed.err
    const code = isRecord(err) && isJjErrorCode(err.code) ? err.code : "unknown"
    const message = isRecord(err) && typeof err.message === "string" ? err.message : JSON.stringify(err)
    const command = isRecord(err) && typeof err.command === "string" ? { command: err.command } : {}
    return Effect.fail(new JjError({ code, message: `jj ${method}: ${message}`, ...command }))
  }
  if (isRecord(parsed) && isRecord(parsed.ok)) {
    return Effect.succeed(parsed.ok)
  }
  return Effect.fail(new JjError({ code: "unknown", message: `jj ${method}: malformed ABI response: ${text}` }))
}

/** A string the operation's response payload is required to carry. */
const stringField = (method: string, payload: OkPayload, field: string): Effect.Effect<string, JjError> => {
  const value = payload[field]
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
      new JjError({ code: "unknown", message: `jj ${method}: ABI response is missing the "${field}" field` })
    )
}

/**
 * Compile (when handed bytes), instantiate over a fresh WASI shim, check the
 * frozen export surface, bind memory, and run the reactor initializer —
 * memory must be bound first because `_initialize` may already issue
 * syscalls.
 */
const instantiate = async (options: BrowserJjOptions): Promise<AbiExports> => {
  const wasi = WasiPreview1.make({
    fs: options.fs,
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr })
  })
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: { ...wasi.imports } }
  const instance = options.wasm instanceof WebAssembly.Module
    ? await WebAssembly.instantiate(options.wasm, imports)
    : (await WebAssembly.instantiate(options.wasm, imports)).instance
  const exports = instance.exports as Record<string, unknown>
  const missing = REQUIRED_EXPORTS.filter((name) =>
    name === "memory" ? !(exports[name] instanceof WebAssembly.Memory) : typeof exports[name] !== "function"
  )
  if (missing.length > 0) {
    throw new Error(`the module does not export the flows_jj ABI (missing: ${missing.join(", ")})`)
  }
  const abi = exports as unknown as AbiExports
  wasi.initialize(abi.memory)
  abi._initialize()
  return abi
}

/**
 * Creates a `Jj` backed by a `flows_jj.wasm` module over a synchronous
 * filesystem slice.
 *
 * Instantiation is lazy — the first operation pays for it — and every
 * operation runs under a single-permit semaphore: the wasm instance is
 * single-threaded mutable state, so concurrent fibers serialize rather than
 * interleave inside it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: BrowserJjOptions): Jj => {
  const root = options.root ?? "/"
  const gate = Semaphore.makeUnsafe(1)
  let ready: AbiExports | undefined

  const ensure: Effect.Effect<AbiExports, JjError> = Effect.suspend(() =>
    ready === undefined
      ? Effect.map(
        Effect.tryPromise({
          try: () => instantiate(options),
          catch: (cause) =>
            new JjError({ code: "unknown", message: `jj: failed to instantiate flows_jj.wasm: ${messageOf(cause)}` })
        }),
        (abi) => {
          ready = abi
          return abi
        }
      )
      : Effect.succeed(ready)
  )

  const invoke = (
    method: string,
    command: string,
    request: Record<string, unknown>
  ): Effect.Effect<OkPayload, JjError> =>
    gate.withPermit(
      Effect.flatMap(ensure, (abi) =>
        Effect.suspend(() => {
          let text: string
          try {
            text = exchange(abi, request)
          } catch (cause) {
            // A trap (proc_exit, a Rust panic, an out-of-range response) is a
            // failed operation, never a failed fiber.
            return Effect.fail(new JjError({ code: "unknown", message: `jj ${method}: ${messageOf(cause)}`, command }))
          }
          return decodeResponse(method, text)
        }))
    )

  return Jj.of({
    snapshot: (message) =>
      invoke("snapshot", "jj snapshot", { op: "snapshot", root, ...(message === undefined ? {} : { message }) }).pipe(
        Effect.flatMap((ok) => stringField("snapshot", ok, "changeId")),
        Effect.map((changeId) => ({ changeId }))
      ),
    restore: (changeId) => Effect.asVoid(invoke("restore", "jj restore", { op: "restore", root, changeId })),
    diff: (from, to) =>
      Effect.flatMap(
        invoke("diff", "jj diff", { op: "diff", root, from, to }),
        (ok) => stringField("diff", ok, "diff")
      ),
    workspaceAdd: (name, path, revision) =>
      Effect.asVoid(
        // The frozen ABI has no revision field on `workspaceAdd`, so a pinned
        // add is the add followed by a workspace-scoped restore: every op
        // carries its own `root`, and rooting the restore at the NEW lane's
        // path pins that workspace's working copy without touching the
        // parent's.
        Effect.flatMap(
          invoke("workspaceAdd", "jj workspace add", { op: "workspaceAdd", root, name, path }),
          () =>
            revision === undefined
              ? Effect.void
              : Effect.asVoid(invoke("restore", "jj restore", { op: "restore", root: path, changeId: revision }))
        )
      ),
    workspaceForget: (name) =>
      Effect.asVoid(invoke("workspaceForget", "jj workspace forget", { op: "workspaceForget", root, name })),
    status: () =>
      Effect.flatMap(invoke("status", "jj status", { op: "status", root }), (ok) => stringField("status", ok, "status"))
  })
}

/**
 * Provides the `Jj` service backed by a `flows_jj.wasm` module.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: BrowserJjOptions): Layer.Layer<Jj> => Layer.succeed(Jj)(make(options))

const fail = (command: string) =>
  Effect.fail(
    new JjError({
      code: "not_installed",
      message: "jj is not available in the browser",
      command
    })
  )

/**
 * Provides a `Jj` service whose every operation fails with `not_installed` —
 * the layer for hosts that have no `flows_jj.wasm` to hand to {@link layer}.
 * It is the same code the node implementation reports when the binary is
 * absent, which keeps callers from needing a browser-specific branch.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerUnsupported: Layer.Layer<Jj> = Layer.succeed(Jj)({
  snapshot: () => fail("jj commit"),
  restore: () => fail("jj edit"),
  diff: () => fail("jj diff"),
  workspaceAdd: () => fail("jj workspace add"),
  workspaceForget: () => fail("jj workspace forget"),
  status: () => fail("jj status")
})
