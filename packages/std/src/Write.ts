/**
 * Write flow declaration and portable handler.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Preserve from "./internal/Preserve.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the write flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "write"

/**
 * Model-facing description of the write flow.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Write UTF-8 text to a path, replacing any existing file; parent directories are created. Prefer edit for targeted changes."

/**
 * Input schema for the write flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the file to write" }),
  content: Schema.String.annotate({ description: "Complete UTF-8 file contents" })
})

/**
 * Output schema for the write flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  path: Schema.String.annotate({ description: "Path that was written" }),
  bytesWritten: Schema.Number.annotate({ description: "Number of UTF-8 bytes written" }),
  created: Schema.Boolean.annotate({ description: "Whether the file did not previously exist" })
})

/**
 * Static conservative effect envelope for the write flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: [], writes: ["/**"] })

/**
 * Narrows the write effect envelope to one input path.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({ tier: "compensable", mode: "hermetic", reads: [], writes: [input.path] })

/**
 * Capabilities required by the write flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:write", "/**")]

/**
 * Declaration-only write flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const writeError = (path: string, message: string): StdError.StdError =>
  new StdError.StdError({ code: "command_failed", message, path })

/**
 * Replaces a file's contents through the permission-aware kernel filesystem.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Write.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existed = yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => false))
  yield* fileSystem.makeDirectory(path.dirname(input.path), { recursive: true }).pipe(
    Effect.mapError(() => writeError(input.path, `Could not create the parent directory of ${input.path}`))
  )
  yield* Preserve.writeFileString(fileSystem, input.path, input.content).pipe(
    Effect.mapError(() => writeError(input.path, `Could not write ${input.path}`))
  )
  return {
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).byteLength,
    created: !existed
  }
})
