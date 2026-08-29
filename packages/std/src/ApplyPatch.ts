/**
 * apply_patch flow declaration and portable handler.
 *
 * A Codex CLI clone: the V4A patch grammar (`*** Begin Patch` /
 * `*** Add File:` / `*** Update File:` / `*** Delete File:` /
 * `*** End Patch`), the fuzzy context-matching applier, and Codex's error
 * and summary text, expressed as a flow over the kernel filesystem.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as ApplyPatchText from "./internal/ApplyPatch.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Preserve from "./internal/Preserve.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the apply_patch flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "apply_patch"

/**
 * Model-facing description of the apply_patch flow. Matches the Codex CLI
 * freeform tool description.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."

/**
 * Input schema for the apply_patch flow.
 *
 * Codex delivers the patch as freeform text; the JSON function fallback uses
 * a single `input` field, which is the shape cloned here.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  input: Schema.String.annotate({ description: "The entire contents of the apply_patch command" })
})

/**
 * Output schema for the apply_patch flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  output: Schema.String.annotate({
    description: "Codex-style summary: 'Success. Updated the following files:' with A/M/D lines"
  }),
  added: Schema.Array(Schema.String).annotate({ description: "Paths of files created by the patch" }),
  modified: Schema.Array(Schema.String).annotate({ description: "Paths of files updated by the patch" }),
  deleted: Schema.Array(Schema.String).annotate({ description: "Paths of files deleted by the patch" })
})

/**
 * Static conservative effect envelope for the apply_patch flow.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })

/**
 * Capabilities required by the apply_patch flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("fs:read", "/**"), capability("fs:write", "/**")]

/**
 * Declaration-only apply_patch flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const ioError = (message: string, path: string): StdError.StdError =>
  new StdError.StdError({ code: "command_failed", message, path })

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Parses and applies a V4A patch through the permission-aware kernel
 * filesystem, preserving Codex error text.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("ApplyPatch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  let parsed: ApplyPatchText.ParsedPatch
  try {
    parsed = ApplyPatchText.parsePatch(input.input)
  } catch (error) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: error instanceof Error ? error.message : String(error)
      })
    )
  }

  const added: Array<string> = []
  const modified: Array<string> = []
  const deleted: Array<string> = []

  for (const hunk of parsed.hunks) {
    switch (hunk.kind) {
      case "add": {
        const parent = path.dirname(hunk.path)
        if (parent !== "" && parent !== ".") {
          yield* fileSystem.makeDirectory(parent, { recursive: true }).pipe(
            Effect.mapError(() => ioError(`Failed to create parent directories for ${hunk.path}`, hunk.path))
          )
        }
        yield* fileSystem.writeFile(hunk.path, encoder.encode(hunk.contents)).pipe(
          Effect.mapError(() => ioError(`Failed to write file ${hunk.path}`, hunk.path))
        )
        added.push(hunk.path)
        break
      }
      case "delete": {
        yield* fileSystem.remove(hunk.path).pipe(
          Effect.mapError(() =>
            new StdError.StdError({
              code: "not_found",
              message: `Failed to delete file ${hunk.path}`,
              path: hunk.path
            })
          )
        )
        deleted.push(hunk.path)
        break
      }
      case "update": {
        const original = yield* fileSystem.readFile(hunk.path).pipe(
          Effect.map((bytes) => decoder.decode(bytes)),
          Effect.mapError(() =>
            new StdError.StdError({
              code: "not_found",
              message: `Failed to read file to update ${hunk.path}`,
              path: hunk.path
            })
          )
        )
        let contents: string
        try {
          contents = ApplyPatchText.deriveNewContents(original, hunk.path, hunk.chunks)
        } catch (error) {
          return yield* Effect.fail(
            new StdError.StdError({
              code: "no_match",
              message: error instanceof Error ? error.message : String(error),
              path: hunk.path
            })
          )
        }
        const destination = hunk.movePath ?? hunk.path
        if (hunk.movePath !== undefined) {
          const parent = path.dirname(hunk.movePath)
          if (parent !== "" && parent !== ".") {
            yield* fileSystem.makeDirectory(parent, { recursive: true }).pipe(
              Effect.mapError(() => ioError(`Failed to create parent directories for ${destination}`, destination))
            )
          }
        }
        yield* Preserve.writeFile(fileSystem, destination, encoder.encode(contents)).pipe(
          Effect.mapError(() => ioError(`Failed to write file ${destination}`, destination))
        )
        if (hunk.movePath !== undefined && hunk.movePath !== hunk.path) {
          yield* fileSystem.remove(hunk.path).pipe(
            Effect.mapError(() => ioError(`Failed to remove original ${hunk.path}`, hunk.path))
          )
        }
        modified.push(destination)
        break
      }
    }
  }

  return {
    output: ApplyPatchText.printSummary({ added, deleted, modified }),
    added,
    deleted,
    modified
  }
})
