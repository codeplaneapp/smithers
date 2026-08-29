/**
 * Drive a run over the wire: plan, approve, run, and watch, through an HTTP and
 * WebSocket control server on loopback.
 *
 * Everything the in-process control plane does is reachable remotely, and
 * nothing about the vtable changes to make that true. `ControlServer.layerHttp`
 * mounts the same `Control` service as RPC — unary procedures over `POST /rpc`,
 * the `watch` stream over `WebSocket /rpc/ws` — and `ControlClient.layer`
 * projects the RPC client back into the identical `Control` interface. The
 * caller below could be handed either one and could not tell.
 *
 * Two transports, because the operations divide cleanly. Plan, approve, run and
 * list are requests with answers. `watch` is a projection of the journal that
 * keeps arriving, so it rides a socket, and a client that subscribes after the
 * fact still receives the entries it missed: the cursor is durable, not a live
 * fan-out that forgets.
 *
 * The server binds `127.0.0.1` on an ephemeral port and authenticates nothing,
 * which is a decision for a loopback example and nothing else. A control plane
 * that listens anywhere else needs a real authenticator; `ControlRpcs` ships a
 * bearer one, and `ControlClient` attaches the credential to both transports.
 */
import { NodeHttpClient, NodeHttpServer, NodeSocket } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlClient, ControlLive, ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as ControlServer from "@smthrs/control/ControlServer"
import { Action, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { durableEngine } from "./durable-layer.ts"

/** The flow the plan is about, and the run the watch follows. */
export const Ship = Flow.make("examples/RemoteShip", {
  payload: { build: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "clearance" })
})

/** The run the remote client watches. */
export const watchedRunId = "remote-ship"

const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

/** What the control plane may be asked to plan. */
const flows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "examples/RemoteShip" as ControlSchema.FlowId,
    description: "Ships a build",
    deployClass: false,
    envelope
  }
]

/** The base URL of a listening TCP server. */
const addressOf = (server: HttpServer.HttpServer["Service"]): string => {
  const address = server.address
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${address.port}`
}

/** What one remote session observed. */
export interface Summary {
  /** The base URL the server bound to, with its ephemeral port. */
  readonly url: string
  /** The flow the plan card names, decoded on the client side of the wire. */
  readonly plannedFlow: string
  /** The receipt `run` answered before the plan was approved. */
  readonly beforeApproval: string
  /** The receipt `run` answered after it was approved. */
  readonly afterApproval: string
  /** The runs `list` reported, over the same connection. */
  readonly listed: ReadonlyArray<string>
  /** The status `list` reported for the parked run. */
  readonly parked: string | undefined
  /** The control events the WebSocket watch replayed, oldest first. */
  readonly watched: ReadonlyArray<string>
}

/**
 * Serves the control plane on loopback and drives it entirely through the RPC
 * client.
 */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let launches = 0

    const executor = ControlExecutor.layer(
      ControlExecutor.make({
        launch: () =>
          Effect.sync(() => {
            launches += 1
            return "pending" as const
          })
      })
    )

    const controlPlane = ControlLive.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SqlControlRuntime.layer({
            flows,
            owner: { hostId: "examples-gateway", pid: 1, nonce: "gateway" }
          }).pipe(Layer.orDie),
          NotificationQueue.layer,
          executor,
          Registry.layerNoop()
        )
      )
    )

    const registrations = Layer.mergeAll(WaitFor.layer, Interpreter.layer(Ship)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )

    // One database beneath the plane and the engine, so the events the client
    // watches are the ones the run wrote.
    const stack = Layer.merge(controlPlane, registrations).pipe(
      Layer.provideMerge(durableEngine(filename, "examples-gateway"))
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        // A real durable run that parks, so the watch has something to report.
        yield* Ship.execute({ build: "v2.0.0" }, { executionId: watchedRunId, discard: true })

        // The server: the same `Control` service, mounted as RPC.
        const served = HttpRouter.serve(
          ControlServer.layerHttp.pipe(
            Layer.provide(ControlRpcs.layerNoopAuth()),
            Layer.provide(RpcSerialization.layerNdjson)
          ),
          { disableListenLog: true, disableLogger: true }
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
          )
        )

        return yield* Effect.gen(function*() {
          const server = yield* HttpServer.HttpServer
          const url = addressOf(server)

          // The client: the same `Control` interface, over two transports.
          const client = ControlClient.layer({ url: `${url}/rpc` }).pipe(
            Layer.provide([
              NodeHttpClient.layerUndici,
              NodeSocket.layerWebSocket(`ws://127.0.0.1:${new URL(url).port}/rpc/ws`),
              RpcSerialization.layerNdjson
            ])
          )

          return yield* Effect.gen(function*() {
            const control = yield* Control.Control

            const card = yield* control.plan({
              flowId: "examples/RemoteShip" as ControlSchema.FlowId,
              input: { build: "v2.0.0" }
            })
            const launch = {
              _tag: "Plan" as const,
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope
            }
            const beforeApproval = yield* control.run({
              ...launch,
              idempotencyKey: "remote:before" as ControlSchema.IdempotencyKey
            })
            yield* control.approve({
              target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
              scope: card.approval.scope,
              idempotencyKey: "remote:approve" as ControlSchema.IdempotencyKey
            })
            const afterApproval = yield* control.run({
              ...launch,
              idempotencyKey: "remote:after" as ControlSchema.IdempotencyKey
            })

            const listed = yield* control.list({ _tag: "runs", filters: {} })
            const runs = listed._tag === "runs" ? listed.items : []

            // `follow: false` asks for a finite snapshot of what is already
            // durable, which is what makes this assertable. Omitting it opens
            // the live stream a UI subscribes to and never ends.
            const watched = yield* control.watch({ runId: watchedRunId as ControlSchema.RunId, follow: false }).pipe(
              Stream.map((event) => event.kind),
              Stream.runCollect
            )

            return {
              url,
              plannedFlow: card.flowId,
              beforeApproval: beforeApproval._tag,
              afterApproval: afterApproval._tag,
              listed: runs.map((run) => run.runId),
              parked: runs.find((run) => run.runId === watchedRunId)?.status,
              watched: [...watched]
            } satisfies Summary
          }).pipe(Effect.provide(client))
        }).pipe(Effect.provide(served))
      }).pipe(Effect.provide(Layer.merge(stack, NodeCrypto.layer)))
    )
  }).pipe(Effect.orDie)
