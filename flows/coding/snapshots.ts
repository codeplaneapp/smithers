/** Private host configuration of the existing Jj service. Plue owns snapshots;
 * the engine keeps immutable preimage references in its existing journal.
 */
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { NativeOptions } from "./native.ts"

const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Snapshot = Schema.Struct({ changeId: CommitId })
const Diff = Schema.Struct({ diff: Schema.String })
const NativeError = Schema.Struct({ code: Schema.String, message: Schema.String })
type Method = "snapshot" | "restore" | "diff"

const failure = (method: Method, code: Jj.JjErrorCode, message: string, cause?: unknown) => new Jj.JjError({
  code, module: "coding/Snapshots", method, message,
  ...(cause === undefined ? {} : { cause: Jj.jjErrorCause(cause) })
})
const codeFor = (code: string): Jj.JjErrorCode => {
  if (code === "invalid_ref" || code === "invalid_request") return "invalid_ref"
  if (code === "unsupported_version" || code === "unsupported_jj") return "unsupported_version"
  if (code === "snapshot_incomplete" || code === "snapshot_refused") return "snapshot_refused"
  if (code === "operation_conflict" || code === "workspace_busy" || code === "revision_conflict") return "conflict"
  return "unknown"
}

const capture = <E>(method: Method, stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFoldEffect(stream, () => ({ text: "", bytes: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const bytes = state.bytes + chunk.length
    if (bytes > limit) return Effect.fail(failure(method, "unknown", "Native snapshot response exceeded its bounded size"))
    return Effect.succeed({ ...state, bytes, text: state.text + state.decoder.decode(chunk, { stream: true }) })
  }).pipe(Effect.map(state => state.text + state.decoder.decode()))

/** Supply the host's existing contained spawner. This same layer runs on Node
 * and Bun; neither it nor the Python adapter owns an execution database.
 *
 * The opaque `snapshot().changeId` is a full immutable commit ID here. It is
 * deliberately distinct from the JJ change ID used by a planned atomic change.
 * Keeping the latter unchanged is the reason for this private configuration.
 */
export const layerAt = (options: NativeOptions) => Layer.effect(Jj.Jj)(Effect.gen(function*() {
  const base = yield* Jj.Jj
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const invoke = (method: Method, fields: Record<string, string> = {}) => Effect.gen(function*() {
    const input = JSON.stringify({ ...fields, operation: method, repositoryPath: options.repositoryPath })
    if (new TextEncoder().encode(input).length > 64 * 1024) {
      return yield* failure(method, "invalid_ref", "Native snapshot request exceeds 64 KiB")
    }
    const process = yield* spawner.spawn(ChildProcess.make(options.python ?? "python3", [
      options.adapterPath ?? "/usr/local/lib/smithers/workspace-coding.py", "--engine"
    ], { stdin: Stream.make(new TextEncoder().encode(input)), cwd: options.repositoryPath }))
    const [stdout, , exitCode] = yield* Effect.all([
      capture(method, process.stdout, 16 * 1024 * 1024),
      capture(method, process.stderr, 64 * 1024), process.exitCode
    ], { concurrency: "unbounded" })
    const result = yield* Effect.try({
      try: () => JSON.parse(stdout) as unknown,
      catch: error => failure(method, "unknown", "Native snapshot adapter returned no valid result", error)
    })
    if (result !== null && typeof result === "object" && "error" in result) {
      const error = yield* Schema.decodeUnknownEffect(NativeError)(result.error).pipe(
        Effect.mapError(error => failure(method, "unknown", "Native snapshot adapter returned an invalid error envelope", error))
      )
      return yield* failure(method, codeFor(error.code), error.message, error)
    }
    if (exitCode !== 0) return yield* failure(method, "unknown", "Native snapshot adapter exited without a successful result")
    return result
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "4 minutes", orElse: () => Effect.fail(failure(method, "unknown", "Native snapshot operation timed out; its outcome requires inspection")) }),
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const error = Cause.squash(cause)
      return Effect.fail(Jj.isJjError(error) ? error : failure(method, "unknown", "Native snapshot process failed", error))
    })
  )
  const exact = (method: Method, value: string) => Schema.decodeUnknownEffect(CommitId)(value).pipe(
    Effect.mapError(() => failure(method, "invalid_ref", "Engine snapshots require full immutable JJ commit IDs; short or mutable references cannot be restored"))
  )
  return Jj.make({
    ...base,
    // Labels stay on the existing action/journal; never describe or open a new
    // native change merely to capture a compensable action's preimage.
    snapshot: () => invoke("snapshot").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      Effect.mapError(error => Jj.isJjError(error) ? error : failure("snapshot", "unknown", "Native snapshot returned an invalid immutable reference", error))
    ),
    restore: reference => exact("restore", reference).pipe(
      Effect.flatMap(changeId => invoke("restore", { changeId })),
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)), Effect.asVoid,
      Effect.mapError(error => Jj.isJjError(error) ? error : failure("restore", "unknown", "Native restore returned an invalid immutable reference", error))
    ),
    diff: (from, to) => Effect.all([exact("diff", from), exact("diff", to)]).pipe(
      Effect.flatMap(([from, to]) => invoke("diff", { from, to })),
      Effect.flatMap(Schema.decodeUnknownEffect(Diff)), Effect.map(result => result.diff),
      Effect.mapError(error => Jj.isJjError(error) ? error : failure("diff", "unknown", "Native diff returned an invalid result", error))
    )
  })
})).pipe(Layer.provide(NodeJj.layerSpawnerAt(options.repositoryPath)))
