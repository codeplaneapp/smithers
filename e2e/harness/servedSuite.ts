/**
 * One served control plane per gateway case, and the plumbing every case
 * repeats.
 *
 * @since 1.0.0
 */
import type { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { controlClient, type ClientOptions, type ControlServerProcess, startControlServer } from "./serveProcess.ts"

/**
 * A served control plane plus a scratch directory, both owned by one case.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServedSuite {
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
  readonly server: () => ControlServerProcess
  /** Runs an effect through a fresh remote client with a valid credential. */
  readonly remote: <A, E>(body: Effect.Effect<A, E, Control.Control>) => Promise<A>
  /** Runs an effect through a client built with explicit options. */
  readonly remoteWith: <A, E>(
    options: Omit<ClientOptions, "url">,
    body: Effect.Effect<A, E, Control.Control>
  ) => Promise<A>
}

/**
 * Creates the per-case fixture. Call `start` in `beforeAll` and `stop` in
 * `afterAll`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const servedSuite = (label: string): ServedSuite => {
  let directory: string | undefined
  let server: ControlServerProcess | undefined

  const current = (): ControlServerProcess => {
    if (server === undefined) throw new Error(`${label}: the served control plane has not been started`)
    return server
  }

  const runWith = <A, E>(
    options: Omit<ClientOptions, "url">,
    body: Effect.Effect<A, E, Control.Control>
  ): Promise<A> =>
    Effect.runPromise(
      body.pipe(
        Effect.provide(controlClient({ ...options, url: current().url }).layer),
        Effect.scoped
      ) as Effect.Effect<A, E>
    )

  return {
    start: async () => {
      directory = mkdtempSync(join(tmpdir(), `smithers-e2e-${label}-`))
      server = await startControlServer(join(directory, "control.sqlite"))
    },
    stop: async () => {
      await server?.stop()
      server = undefined
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    },
    server: current,
    remote: (body) => runWith({ credential: current().token }, body),
    remoteWith: runWith
  }
}
