/**
 * In-process sync service and RPC transport wiring for tests.
 *
 * @since 0.1.0
 */
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import * as RunCatalog from "../RunCatalog.ts"
import * as SyncClient from "../SyncClient.ts"
import * as SyncPrincipal from "../SyncPrincipal.ts"
import * as SyncRpcs from "../SyncRpcs.ts"
import * as SyncServer from "../SyncServer.ts"
import type { Pair } from "./TestSocket.ts"

const layerNoopAuth = Layer.succeed(SyncRpcs.SyncAuth)((effect) => effect)

/**
 * An authentication middleware that trusts every connection as the workspace
 * owner. Test-only by construction: replication-mechanics suites use it so
 * they exercise paging and streaming without provisioning capabilities,
 * while the authentication suites use the production `SyncAuth.layer`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWorkspaceAuth = Layer.succeed(SyncRpcs.SyncAuth)((effect) =>
  Effect.provideService(effect, SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("test-workspace-owner"))
)

/**
 * Provides the durable in-memory journal, a mutable empty run catalog, the
 * owner-trusting {@link layerWorkspaceAuth} middleware, and the production
 * sync server.
 *
 * Tests that need runs in the workspace may register them through their own
 * `RunCatalog.makeMemory` fixture before providing a more specific layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTest = SyncServer.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestJournal.layer(),
      Layer.effect(RunCatalog.RunCatalog)(Effect.map(RunCatalog.makeMemory(), ({ catalog }) => catalog)),
      layerWorkspaceAuth
    )
  )
)

/**
 * Provides no-op sync dependencies for consumers that only require the ports.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = Layer.mergeAll(
  SyncClient.layerNoop(),
  SyncServer.layerNoop,
  RunCatalog.layerNoop,
  layerNoopAuth
)

/**
 * Starts an RPC server over the pair's server endpoint and returns a sync
 * client over the client endpoint. JSON serialization is deliberately used so
 * frame faults can inspect test traffic without coupling to sync schemas.
 *
 * @category constructors
 * @since 0.1.0
 */
export const connect = (pair: Pair) =>
  Effect.gen(function*() {
    const sync = yield* SyncServer.SyncServer
    const serverSerialization = RpcSerialization.json.makeUnsafe()
    const serverWriter = yield* pair.server.writer
    const handlers = SyncServer.layerHandlers.pipe(
      Layer.provide(Layer.succeed(SyncServer.SyncServer, sync))
    )
    // Use the production schema boundary: raw server exits contain Effect
    // causes, whose JSON representation is not the RPC wire encoding.
    const serverProtocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        yield* pair.server.runRaw((bytes) =>
          Effect.forEach(
            serverSerialization.decode(bytes),
            (message) => writeRequest(0, message as never),
            { discard: true }
          )
        ).pipe(Effect.forkScoped)
        return {
          disconnects: yield* Queue.make<number>(),
          send: (_clientId, response) => Effect.orDie(serverWriter(serverSerialization.encode(response)!)),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true
        }
      })
    )
    yield* RpcServer.make(SyncRpcs.SyncRpcs, { disableFatalDefects: true }).pipe(
      Effect.provide(handlers),
      Effect.provideService(RpcServer.Protocol, serverProtocol),
      Effect.forkScoped
    )

    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, pair.client),
      Effect.provide(RpcSerialization.layerJson)
    )
    const client = yield* RpcClient.make(SyncRpcs.SyncRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
    return yield* SyncClient.make({ client })
  })
