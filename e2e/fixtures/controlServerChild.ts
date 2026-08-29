/**
 * The served control plane the gateway family talks to.
 *
 * This is a separate operating-system process on purpose. An in-process server
 * shares the client's event loop, its memory, and its fibers, so a suite built
 * on one cannot honestly test a dropped socket, a bounded resident set, or a
 * credential the client never learns. Everything here is the shipped
 * composition: `@smthrs/cli`'s `NodeControl.layerServerBearerAuth` over the
 * durable `ControlLive` stack on a real SQLite file, which is what a served
 * Smithers workspace runs.
 *
 * It prints one JSON line — `{"phase":"ready","port":<port>}` — and then serves
 * until it is signalled.
 *
 * Usage: `node controlServerChild.ts <filename> <bearer token>`
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { NodeControl } from "@smthrs/cli"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { ControlExecutor, ControlLive, SqlControlRuntime } from "@smthrs/control"
import { Migrations as JournalMigrations, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { HttpServer } from "effect/unstable/http"

const filename = process.argv[2]
const token = process.argv[3]
if (filename === undefined || token === undefined) {
  throw new Error("usage: controlServerChild.ts <filename> <token>")
}

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const migrated = Layer.provideMerge(
  Layer.merge(JournalMigrations.layer, RunStoreMigrations.layer),
  database
)
const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(Layer.provideMerge(migrated))

const controlPlane = ControlLive.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  )
)

const stack = controlPlane.pipe(Layer.provideMerge(Layer.merge(stores, NodeCrypto.layer)))

const program = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  const address = server.address
  if (address._tag !== "TcpAddress") return yield* Effect.die(new Error("expected a TCP control server"))
  process.stdout.write(`${JSON.stringify({ phase: "ready", port: address.port })}\n`)
  return yield* Effect.never
}).pipe(
  Effect.provide(
    NodeControl.layerServerBearerAuth(
      { token, principal: { id: "e2e-operator", kind: "operator" } },
      { host: "127.0.0.1", port: 0 }
    ).pipe(Layer.provide(stack))
  ),
  Effect.scoped
)

// A process entry point: running the Effect here is the intended boundary.
Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`)
  process.exitCode = 1
})
