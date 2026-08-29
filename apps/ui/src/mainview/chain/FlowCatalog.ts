import { Catalog } from "@smthrs/chain"
import { Effect } from "effect"
import type { CommandRegistry } from "../flows/Commands"
import type { FlowEntry } from "../flows/registry"

/*
 * The thin adapter that lets the legacy chain runtime call registered flows.
 *
 * This is NOT a second catalog. It holds no capability table, no trigger
 * filter, and no description copy of its own: every one of those now lives on
 * the flow declaration, and this module only restates the registry's
 * model-invocable entries in the shape `@smthrs/chain` expects. The set it
 * exposes is `registry.callable()` verbatim, and every entry executes through
 * `registry.runForAgent` — the actor-attributed path with the user-only guard,
 * slash normalization, and the requirement axis.
 *
 * It exists only until the harness cell loop replaces ChainRuntime, at which
 * point the bindings are consumed directly and this file goes away.
 */

/** The one payload shape a chain entry accepts: optional argument text. */
const argsOf = (name: string, payload: unknown): Effect.Effect<string | undefined, Catalog.CallError> => {
  if (payload === undefined || payload === null) return Effect.succeed(undefined)
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return Effect.fail(
      new Catalog.CallError({ name, message: `payload must be an object like { args?: string }` })
    )
  }
  const args = (payload as { readonly args?: unknown }).args
  if (args === undefined) return Effect.succeed(undefined)
  if (typeof args !== "string") {
    return Effect.fail(new Catalog.CallError({ name, message: `payload.args must be a string` }))
  }
  return Effect.succeed(args)
}

const entryFor = (commands: CommandRegistry, entry: FlowEntry): Catalog.Entry => {
  const { name, description, capabilities } = entry.binding.descriptor
  return {
    name,
    description,
    capabilities,
    handler: (payload) =>
      argsOf(name, payload).pipe(
        Effect.flatMap((args) =>
          Effect.tryPromise({
            try: () => commands.runForAgent(name, args),
            catch: (cause) => new Catalog.CallError({ name, message: `flow threw: ${String(cause)}` })
          })
        ),
        Effect.flatMap((outcome) => {
          switch (outcome.status) {
            case "executed":
              return Effect.succeed<unknown>(outcome.value ?? `executed /${name}`)
            case "unknown-command":
              return Effect.fail(new Catalog.CallError({ name, message: `unknown-command: ${name}` }))
            case "failed":
              return Effect.fail(new Catalog.CallError({ name, message: outcome.error }))
          }
        })
      )
  }
}

/** Every flow the agent may call: the registry narrowed to model-invocable entries. */
export const commandEntries = (commands: CommandRegistry): ReadonlyArray<Catalog.Entry> =>
  commands.callable().map((entry) => entryFor(commands, entry))

/**
 * The subset the prompt's catalog block teaches: callable flows that are not
 * hidden — byte-for-byte the set the list action shows.
 */
export const disclosedEntries = (commands: CommandRegistry): ReadonlyArray<Catalog.Entry> =>
  commands
    .callable()
    .filter((entry) => entry.metadata.hidden !== true)
    .map((entry) => entryFor(commands, entry))
