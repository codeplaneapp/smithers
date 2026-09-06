/**
 * Shared local persistence and error boundaries for operator commands.
 *
 * @since 1.0.0
 */
import { NodeCrypto } from "@effect/platform-node"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Redaction from "@smthrs/journal/Redaction"
import { Effect, Layer } from "effect"
import { z } from "incur"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import * as Presentation from "../cli/Presentation.ts"
import * as Environment from "../Environment.ts"
import * as ControlDatabaseMigrations from "../internal/ControlDatabaseMigrations.ts"
import * as Project from "../Project.ts"

/**
 * Connection fields shared by local operator commands.
 * @category schemas
 * @since 1.0.0
 */
export const localFields = {
  root: z.string().optional().describe("Project root (defaults to the nearest Smithers project)"),
  remote: z.string().optional().describe("Remote control server; local operator commands refuse this option"),
  credential: z.string().optional().describe("Remote control credential")
}

/**
 * Parsed project selection for local operator commands.
 * @category models
 * @since 1.0.0
 */
export interface LocalOptions {
  readonly root?: string | undefined
  readonly remote?: string | undefined
  readonly credential?: string | undefined
}

/**
 * Resolves the project root and refuses remote operator access.
 * @category constructors
 * @since 1.0.0
 */
export const localRoot = (options: LocalOptions): string => {
  if (options.remote !== undefined || Environment.read(process.env, "SMITHERS_REMOTE") !== undefined) {
    throw new Error("This operator command requires the host that owns .flows/control.db; --remote is not supported.")
  }
  const root = Project.root(options.root, process.cwd())
  Project.assertRoot(root)
  return root
}

/**
 * Shares the authoritative control database and its migration ledger.
 * @category layers
 * @since 1.0.0
 */
export const databaseLayer = (root: string) => {
  const database = Layer.suspend(() => {
    mkdirSync(join(root, ".flows"), { recursive: true })
    return NodeDatabase.layer({ filename: join(root, ".flows", "control.db") })
  })
  return Layer.mergeAll(ControlDatabaseMigrations.layer, NodeCrypto.layer).pipe(
    Layer.provideMerge(DurableWriter.layer().pipe(Layer.provideMerge(database)))
  )
}

/**
 * Minimal Incur error boundary used by operator commands.
 * @category models
 * @since 1.0.0
 */
export interface ErrorContext extends Presentation.Context {
  readonly error: (error: { readonly code: string; readonly message: string; readonly exitCode: number }) => never
}

/**
 * Keeps typed Effect failures readable and lets Incur own structured output.
 * @category constructors
 * @since 1.0.0
 */
export const execute = async <A>(context: ErrorContext, operation: () => Promise<A>): Promise<A> => {
  try {
    return Presentation.finish(context, await operation())
  } catch (cause) {
    return context.error({
      code: "operator_failed",
      message: String(Redaction.redact(cause instanceof Error ? cause.message : String(cause))),
      exitCode: 1
    })
  }
}

/**
 * Executes a service-free Effect for an Incur handler.
 * @category constructors
 * @since 1.0.0
 */
export const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
