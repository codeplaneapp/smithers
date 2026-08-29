/**
 * The served control plane, out of process, and the clients that talk to it.
 *
 * `startControlServer` spawns `fixtures/controlServerChild.ts` and waits for its
 * ready line; `controlClient` builds the shipped `ControlClient` over Node's
 * HTTP and WebSocket transports, the same pair `@smthrs/cli` uses for a
 * `--remote` invocation. The WebSocket constructor is the tracked one from
 * {@link ../harness/dropWebSocket.ts}, so a suite can cut the live socket.
 *
 * @since 1.0.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Control as ControlService, ControlClient } from "@smthrs/control"
import * as Layer from "effect/Layer"
import { RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { trackingWebSocketConstructor, type TrackedWebSockets } from "./dropWebSocket.ts"
import { killProcess } from "./killProcess.ts"

const child = fileURLToPath(new URL("../fixtures/controlServerChild.ts", import.meta.url))

/**
 * A running served control plane.
 *
 * @since 1.0.0
 * @category models
 */
export interface ControlServerProcess {
  readonly pid: number
  readonly port: number
  /** The base URL; `/rpc` and `/rpc/ws` hang off it. */
  readonly url: string
  /** The bearer credential the server was started with. */
  readonly token: string
  readonly process: ChildProcess
  readonly stderr: () => string
  /** Kills the server and waits for the operating system to reap it. */
  readonly stop: () => Promise<void>
}

/**
 * Starts a served control plane over `filename`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const startControlServer = async (filename: string): Promise<ControlServerProcess> => {
  const token = `e2e-${randomUUID()}`
  const process_ = spawn(process.execPath, [child, filename, token], { stdio: ["ignore", "pipe", "pipe"] })
  const pid = process_.pid
  if (pid === undefined) throw new Error("control server child has no pid")

  let stderr = ""
  process_.stderr?.setEncoding("utf8")
  process_.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })

  const port = await new Promise<number>((resolve, reject) => {
    let buffered = ""
    const timer = setTimeout(() => reject(new Error(`control server never became ready\n${stderr}`)), 60_000)
    process_.stdout?.setEncoding("utf8")
    process_.stdout?.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timer)
      resolve((JSON.parse(buffered.slice(0, newline)) as { readonly port: number }).port)
    })
    process_.once("error", (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    process_.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`control server exited with ${String(code)} before it was ready\n${stderr}`))
    })
  })

  let stopped = false
  return {
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    process: process_,
    stderr: () => stderr,
    stop: async () => {
      if (stopped) return
      stopped = true
      await killProcess(process_)
    }
  }
}

/**
 * How a client authenticates and which socket it is given.
 *
 * @since 1.0.0
 * @category models
 */
export interface ClientOptions {
  readonly url: string
  /** Omit or misspell to exercise the server's refusal. */
  readonly credential?: string | undefined
  /** Reuse a tracker across two clients to count reconnects. */
  readonly sockets?: TrackedWebSockets | undefined
}

/**
 * Builds the shipped remote `Control` client, and hands back the socket tracker
 * so a suite can drop the live connection.
 *
 * @since 1.0.0
 * @category constructors
 */
export const controlClient = (
  options: ClientOptions
): { readonly layer: Layer.Layer<ControlService.Control>; readonly sockets: TrackedWebSockets } => {
  const sockets = options.sockets ?? trackingWebSocketConstructor(options.credential)
  const websocket = Socket.layerWebSocket(`${options.url.replace(/\/+$/, "")}/rpc/ws`).pipe(
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, sockets.construct))
  )
  const layer = ControlClient.layer({
    url: `${options.url.replace(/\/+$/, "")}/rpc`,
    ...(options.credential === undefined ? {} : { credential: options.credential })
  }).pipe(
    Layer.provide([NodeHttpClient.layerUndici, websocket, RpcSerialization.layerNdjson])
  ) as unknown as Layer.Layer<ControlService.Control>
  return { layer, sockets }
}
