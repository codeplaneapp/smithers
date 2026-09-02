/**
 * Shared validating bank and namespace resolution.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { MemoryError } from "../MemoryError.ts"
import * as Namespace from "../Namespace.ts"

/**
 * Resolves a structured namespace or public bank name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveNamespace = (
  input: Namespace.Namespace | string
): Effect.Effect<{ readonly namespace: Namespace.Namespace; readonly bank: string }, MemoryError> => {
  if (typeof input !== "string") {
    return Schema.decodeUnknownEffect(Namespace.Namespace)(input).pipe(
      Effect.mapError(() =>
        new MemoryError({
          code: "invalid_namespace",
          message: "memory namespace is invalid"
        })
      ),
      Effect.map((namespace) => ({ namespace, bank: `${namespace.kind}-${namespace.id}` }))
    )
  }
  if (input.length === 0) {
    return Effect.fail(new MemoryError({ code: "invalid_namespace", message: "memory bank must not be empty" }))
  }
  for (const kind of Namespace.Kind.literals) {
    const prefix = `${kind}-`
    if (input.startsWith(prefix) && input.length > prefix.length) {
      return Effect.succeed({
        namespace: { kind, id: input.slice(prefix.length) },
        bank: input
      })
    }
  }
  return Effect.succeed({
    namespace: { kind: "flow", id: input },
    bank: input
  })
}
