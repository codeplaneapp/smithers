/**
 * `smithers serve`: the control plane over HTTP, for the product UI and for
 * any client that is not this process.
 *
 * The composition itself lives in `NodeControl` (`layerServerBearerAuth` and
 * `layerServerNoopAuth`); this module owns the one decision the verb has to
 * make, which is whether the requested bind is allowed at all.
 *
 * The rule is the rc contract's (section 4.1): loopback needs nothing,
 * anything else needs both an explicit `--listen` and a bearer token. It is
 * spelled out here, as data, because the failure mode it prevents —
 * an unauthenticated control plane on a laptop's LAN address, able to launch
 * agents with the operator's credentials — is silent when it happens.
 *
 * @since 1.0.0
 */
import { Effect, Layer } from "effect"
import * as CliError from "./CliError.ts"
import * as NodeControl from "./NodeControl.ts"

/**
 * The addresses that need no opt-in.
 *
 * @category constants
 * @since 1.0.0
 */
export const loopbackHosts: ReadonlyArray<string> = ["127.0.0.1", "::1", "localhost"]

/**
 * The default bind.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultBind = { host: "127.0.0.1", port: 3000 } as const

/**
 * Whether a host is a loopback address.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isLoopback = (host: string): boolean => loopbackHosts.includes(host)

/**
 * What the verb was asked to do.
 *
 * @category models
 * @since 1.0.0
 */
export interface Bind {
  readonly host: string
  readonly port: number
  readonly listen: boolean
  readonly credential: string | undefined
}

/**
 * The refusal for a bind that is not allowed, or `undefined` when it is.
 *
 * @category getters
 * @since 1.0.0
 */
export const refuse = (bind: Bind): CliError.UnsupportedError | undefined => {
  if (isLoopback(bind.host)) return undefined
  if (!bind.listen) {
    return new CliError.UnsupportedError({
      message: `Refusing to bind ${bind.host}: pass --listen to serve on a non-loopback address.`
    })
  }
  if (bind.credential === undefined || bind.credential === "") {
    return new CliError.UnsupportedError({
      message:
        `Refusing to bind ${bind.host} without a bearer token: pass --credential or set SMITHERS_API_KEY.`
    })
  }
  return undefined
}

/**
 * The line printed once the server is listening.
 *
 * @category constructors
 * @since 1.0.0
 */
export const banner = (bind: Bind): string => {
  const base = `http://${bind.host.includes(":") ? `[${bind.host}]` : bind.host}:${bind.port}`
  return [
    `smithers serve listening on ${base}`,
    `  control rpc      ${base}/rpc, ${base.replace(/^http/, "ws")}/rpc/ws`,
    `  health           ${base}/health`,
    bind.credential === undefined ? "  auth             none (loopback only)" : "  auth             bearer token"
  ].join("\n")
}

/**
 * Hosts the control server until the process is interrupted.
 *
 * The composition is `NodeControl`'s: bearer authentication when a credential
 * is configured, permissive authentication only on loopback. `Layer.launch`
 * keeps the scope alive, so the server lives exactly as long as the command.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host = (bind: Bind) =>
  Effect.gen(function*() {
    const refusal = refuse(bind)
    if (refusal !== undefined) return yield* Effect.fail(refusal)
    const options = { host: bind.host, port: bind.port, listen: bind.listen }
    const server = bind.credential === undefined || bind.credential === ""
      ? NodeControl.layerServerNoopAuth(options)
      : NodeControl.layerServerBearerAuth(
        { token: bind.credential, principal: { kind: "operator", id: "cli" } },
        options
      )
    yield* Layer.launch(server)
  })
