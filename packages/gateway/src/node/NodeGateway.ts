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
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import type { ListenOptions } from "node:net"
import { GatewayError, settingRefusal } from "../GatewayError.ts"
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
  /** Maximum bytes accepted on one HTTP RPC request. Default one MiB. */
  readonly maxRequestBodyBytes?: number | undefined
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
 * The typed refusal a requested bind earns, or `undefined` when it is allowed.
 *
 * Every start-time rule this module enforces answers here as a `bind_failed`
 * `GatewayError`, so a host that wants to report a refusal rather than crash on
 * one asks this before it composes a layer. {@link listenOptions} and
 * {@link layer} raise exactly what this returns.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const bindRefusal = (options: ServerOptions): GatewayError | undefined => {
  const setting = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis) ??
    settingRefusal("The gateway request body limit", options.maxRequestBodyBytes)
  if (setting !== undefined) return setting
  const host = options.host ?? "127.0.0.1"
  if (isLoopbackHost(host)) return undefined
  if (options.listen !== true) {
    return new GatewayError({
      code: "bind_failed",
      message: `Refusing non-loopback gateway bind ${host} without an explicit --listen opt-in`
    })
  }
  if (options.credential === undefined || options.credential === "") {
    return new GatewayError({
      code: "bind_failed",
      message: `Refusing non-loopback gateway bind ${host} without a bearer credential`
    })
  }
  return undefined
}

/**
 * Applies the bind policy, or raises the `bind_failed` `GatewayError` naming
 * exactly which rule refused.
 *
 * The raise is what a composition sees, because a layer is built rather than
 * run: `Layer.mergeAll` calls this while the host is still assembling itself.
 * {@link bindRefusal} is the same policy as a value.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const listenOptions = (options: ServerOptions): ListenOptions => {
  const refusal = bindRefusal(options)
  if (refusal !== undefined) throw refusal
  // `credential`, `listen`, and the keepalive cadence are this module's, not
  // `node:net`'s: they are named here so the rest is exactly a bind.
  const {
    credential: _credential,
    heartbeatMillis: _cadence,
    listen: _listen,
    maxRequestBodyBytes: _maxBody,
    ...node
  } = options
  return { ...node, host: node.host ?? "127.0.0.1" }
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
    // The bypass is safe only because `listenOptions` refuses any bind but
    // loopback when no credential is configured, so nothing off this machine
    // can reach the RPC mount that runs as the local operator. Changing that
    // bind rule without changing this branch reopens the control plane.
    // eslint-disable-next-line no-restricted-syntax -- loopback-only bind, see above
    ? ControlRpcs.layerNoopAuth({ id: "local", kind: "operator", stampedAt: 0 })
    : ControlRpcs.layerBearerAuth({
      token: options.credential,
      principal: { id: "gateway", kind: "bearer" }
    })

/** Authenticates protected HTTP paths before any request body is read. */
const ingressOptions = (options: ServerOptions): GatewayServer.IngressOptions => {
  const maxRequestBodyBytes = options.maxRequestBodyBytes
  if (options.credential === undefined || options.credential === "") {
    return maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }
  }
  const authenticator = ControlRpcs.bearerAuthenticator({
    token: options.credential,
    principal: { id: "gateway", kind: "bearer" }
  })
  return {
    ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
    authorize: (headers) =>
      authenticator.authenticate(headers).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true })
      )
  }
}

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
 * A bind this module's policy refuses raises the `bind_failed` `GatewayError`
 * {@link bindRefusal} names, while the layer is being built. A host that wants
 * to answer a refusal rather than raise one calls {@link bindRefusal} first.
 * A listen failure the operating system reports, such as an address already in
 * use, is not mapped here: it stays the `NodeHttpServer` failure it is.
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
    GatewayServer.layer(health, {
      ...(options.heartbeatMillis === undefined ? {} : { heartbeatMillis: options.heartbeatMillis }),
      ingress: ingressOptions(options)
    }).pipe(
      Layer.provide(layerAuth(options)),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, listenOptions(options)))
  )
