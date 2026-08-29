/**
 * Drive a run over the wire: plan, approve, run, and watch a flow the host
 * discovered on disk, through an HTTP and WebSocket control server on loopback.
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
 * **The catalog is discovery, not a list in this file.** `<root>/flows/**` is
 * scanned by `Executable.layerProject` into the registry `control.list` reads,
 * so the flow the client plans is named by the directory it was found in.
 * `Executable.layer` turns each discovered descriptor into a registered durable
 * flow, so the same descriptor the client planned is the one the engine drives:
 * the run the watch follows is `flows/ship/flow.mdx` executing through the
 * `examples/RemoteShip` flow its frontmatter delegates to.
 *
 * The server binds `127.0.0.1` on an ephemeral port and authenticates nothing,
 * which is a decision for a loopback example and nothing else. A control plane
 * that listens anywhere else needs a real authenticator; `ControlRpcs` ships a
 * bearer one, and `ControlClient` attaches the credential to both transports.
 */
import { NodeHttpClient, NodeHttpServer, NodeSocket } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Control, ControlClient, ControlLive, type ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as ControlServer from "@smthrs/control/ControlServer"
import { Action, Flow, type FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { NotificationQueue } from "@smthrs/notifications"
import { Executable, Registry } from "@smthrs/registry"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { durableEngine } from "./durable-layer.ts"

/**
 * The flow every descriptor in this project delegates to.
 *
 * Its payload is the `Executable.Invocation` envelope rather than a schema of
 * its own, because one registered delegate runs many descriptors: the envelope
 * carries the discovered flow's name, the caller's input, and the rendered
 * body. Here the body is a durable wait, so a launched run parks instead of
 * finishing, which is what gives the watch something to replay.
 */
export const Ship = Flow.make("examples/RemoteShip", {
  payload: Executable.Invocation,
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "clearance" })
})

/** The project whose `flows/` directory the control plane serves. */
export const projectRoot: string = join(dirname(fileURLToPath(import.meta.url)), "24-project")

/** The name discovery derives for `flows/ship/flow.mdx` from its directory. */
export const discoveredFlow = "ship"

/** The run the remote client watches. */
export const watchedRunId = "remote-ship"

/** The platform services discovery and body loading read the project through. */
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/**
 * The registry the control plane lists flows from and the engine registers
 * them from: `<projectRoot>/flows/**`, scanned, with bodies still unread.
 */
const registry = Executable.layerProject({ root: projectRoot }).pipe(Layer.provide(platform), Layer.orDie)

/** How a discovered descriptor is turned into something the engine can drive. */
const bridge: Executable.Options = { delegates: [Ship] }

/**
 * Starts a discovered flow on the durable engine.
 *
 * A bridged flow declares open requirements: the bridge cannot know at the
 * type level what the delegate a descriptor names will need, so `Executable`
 * says `any`. The host does know — it registered the delegate — so the launch
 * is narrowed here instead of letting `any` widen every effect downstream of
 * it.
 */
const launch = (
  executable: Executable.Executable,
  input: Schema.Json,
  executionId: string
): Effect.Effect<string, never, FlowRuntime.FlowRuntime | Crypto.Crypto> =>
  (executable.flow.execute({ input }, { executionId, discard: true }) as Effect.Effect<
    string,
    unknown,
    FlowRuntime.FlowRuntime | Crypto.Crypto
  >).pipe(Effect.orDie)

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
  /** The flows `list` reported, discovered on disk and read over the wire. */
  readonly catalog: ReadonlyArray<string>
  /** The flow the plan card names, decoded on the client side of the wire. */
  readonly plannedFlow: string
  /** The collaborator flows the planned envelope carries, from the descriptor. */
  readonly plannedEnvelope: ReadonlyArray<string>
  /** The receipt `run` answered before the plan was approved. */
  readonly beforeApproval: string
  /** The receipt `run` answered after it was approved. */
  readonly afterApproval: string
  /** The flows the executor was handed, in launch order. */
  readonly launched: ReadonlyArray<string>
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
    const launched: Array<string> = []

    const executor = ControlExecutor.layer(
      ControlExecutor.make({
        launch: ({ plan }) =>
          Effect.sync(() => {
            launched.push(plan.card.flowId)
            return "pending" as const
          })
      })
    )

    // What the plane may be asked to plan is what discovery found. The scan
    // happens once, here, so the runtime is configured with the descriptors on
    // disk rather than a list this file keeps in step with them by hand.
    const discovered = yield* Effect.gen(function*() {
      const found = yield* Registry.Registry
      return yield* found.list()
    }).pipe(Effect.provide(registry), Effect.orDie)

    const flows = discovered.map((descriptor): ControlRuntime.MemoryFlow => ({
      flowId: descriptor.name as ControlSchema.FlowId,
      description: descriptor.description,
      deployClass: false,
      // The envelope a client approves is the one the descriptor declared, so
      // approving a plan cannot widen it past what the flow asked for.
      envelope: { capabilities: descriptor.capabilities, flows: descriptor.flows, budget: {} }
    }))

    const controlPlane = ControlLive.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SqlControlRuntime.layer({
            flows,
            owner: { hostId: "examples-gateway", pid: 1, nonce: "gateway" }
          }).pipe(Layer.orDie),
          NotificationQueue.layer,
          executor
        )
      )
    )

    // Every discovered descriptor is registered as a durable flow, beside the
    // delegate they name. `Executable.layer` reads the catalog off the same
    // registry the plane lists from, so nothing here names a flow twice.
    const registrations = Layer.mergeAll(
      WaitFor.layer,
      Interpreter.layer(Ship),
      Executable.layer(bridge).pipe(Layer.orDie)
    ).pipe(Layer.provideMerge(Action.layerImplementations))

    // One database beneath the plane and the engine, so the events the client
    // watches are the ones the run wrote.
    const stack = Layer.merge(controlPlane, registrations).pipe(
      Layer.provideMerge(durableEngine(filename, "examples-gateway")),
      Layer.provideMerge(Layer.merge(registry, platform))
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        // A real durable run of the DISCOVERED flow, so the watch reports the
        // descriptor's own execution and not a stand-in declared in this file.
        const executable = yield* Executable.fromRegistry(discoveredFlow, bridge).pipe(Effect.orDie)
        yield* launch(executable, { build: "v2.0.0" }, watchedRunId)

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

            // What this host can run, asked for from the other end of the wire.
            const catalogued = yield* control.list({ _tag: "flows" })
            const catalog = catalogued._tag === "flows" ? catalogued.items.map((flow) => flow.flowId) : []

            const card = yield* control.plan({
              flowId: discoveredFlow as ControlSchema.FlowId,
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
              catalog,
              plannedFlow: card.flowId,
              plannedEnvelope: card.envelope.flows,
              beforeApproval: beforeApproval._tag,
              afterApproval: afterApproval._tag,
              launched: [...launched],
              listed: runs.map((run) => run.runId),
              parked: runs.find((run) => run.runId === watchedRunId)?.status,
              watched: [...watched]
            } satisfies Summary
          }).pipe(Effect.provide(client))
        }).pipe(Effect.provide(served))
      }).pipe(Effect.provide(Layer.merge(stack, NodeCrypto.layer)))
    )
  }).pipe(Effect.orDie)
