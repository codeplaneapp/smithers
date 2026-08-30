/**
 * The Node host for the assembled gateway: bind policy, credential policy,
 * and the one composition a `smithers serve` verb hosts.
 *
 * Two rules decide whether a bind is allowed, and both fail closed:
 *
 * 1. A non-loopback host requires an explicit `listen` opt-in. Binding
 *    `0.0.0.0` because a port was free is how a workspace gateway ends up on
 *    a shared network by accident.
 * 2. A non-loopback bind requires a bearer credential. The control plane can
 *    launch runs, cancel them, and approve capability grants; reachable from
 *    another machine, an unauthenticated one is a remote execution service.
 *
 * A loopback bind with no credential is allowed and is the local default:
 * the trust boundary there is the machine account, and requiring a token to
 * talk to your own workspace would only teach people to write it down.
 *
 * @since 1.0.0
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { ControlRpcs } from "@smthrs/control"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import type { ListenOptions } from "node:net"
import * as GatewayServer from "../GatewayServer.ts"

/**
 * Where the gateway binds, and whether a non-loopback bind was asked for.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServerOptions extends ListenOptions {
  /** The `--listen` opt-in required for a non-loopback host. */
  readonly listen?: boolean | undefined
  /** The shared bearer credential, required for a non-loopback bind. */
  readonly credential?: string | undefined
  /**
   * How often an idle followed `Watch` emits a keepalive frame on `/rpc/ws`,
   * defaulting to `Projections.heartbeatIntervalMillis`. A relay with an idle
   * cut shorter than that one needs a shorter cadence here.
   */
  readonly heartbeatMillis?: number | undefined
}

/**
 * The default bind: loopback, port 7331, no credential.
 *
 * @since 1.0.0
 * @category models
 */
export const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 7331 }

/**
 * Whether a host names this machine only.
 *
 * @param host the host to classify
 * @since 1.0.0
 * @category predicates
 */
export const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "::1" || host === "localhost"

/**
 * Applies the bind policy, or explains exactly which rule refused.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const listenOptions = (options: ServerOptions): ListenOptions => {
  // `credential`, `listen`, and the keepalive cadence are this module's, not
  // `node:net`'s: they are named here so the rest is exactly a bind.
  const { credential, heartbeatMillis: _cadence, listen, ...node } = options
  const host = node.host ?? "127.0.0.1"
  if (isLoopbackHost(host)) return { ...node, host }
  if (listen !== true) {
    throw new Error(`Refusing non-loopback gateway bind ${host} without an explicit --listen opt-in`)
  }
  if (credential === undefined || credential === "") {
    throw new Error(`Refusing non-loopback gateway bind ${host} without a bearer credential`)
  }
  return { ...node, host }
}

/**
 * The authentication both RPC mounts run under.
 *
 * A configured credential authenticates every request that presents it and
 * stamps the same server-owned principal. With no credential the composition
 * is loopback-only (see {@link listenOptions}) and every request runs as the
 * local operator.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export const layerAuth = (options: ServerOptions): Layer.Layer<ControlRpcs.ControlAuth> =>
  options.credential === undefined || options.credential === ""
    ? ControlRpcs.layerNoopAuth({ id: "local", kind: "operator", stampedAt: 0 })
    : ControlRpcs.layerBearerAuth({
      token: options.credential,
      principal: { id: "gateway", kind: "bearer" }
    })

/**
 * Hosts the assembled gateway on a Node HTTP server.
 *
 * Supplies the bind policy, the shared-credential authentication both RPC
 * mounts run under, and newline-delimited JSON as the wire serialization. The
 * caller supplies what the mounts read through: `Control`, `Projections`,
 * `SyncServer`, and the `SyncAuth` middleware.
 *
 * The returned layer retains the concrete `HttpServer` service, so a caller
 * that bound port 0 can read the ephemeral address it got.
 *
 * @param health the identity `GET /health` answers with
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export const layer = (
  health: GatewayServer.Health,
  options: ServerOptions = defaultServerOptions
) =>
  HttpRouter.serve(
    GatewayServer.layer(health, options.heartbeatMillis).pipe(
      Layer.provide(layerAuth(options)),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, listenOptions(options)))
  )
