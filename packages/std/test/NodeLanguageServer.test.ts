import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Queue, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Lsp from "../src/Lsp.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

const decodeFrame = (frame: Uint8Array): Readonly<Record<string, unknown>> => {
  const text = new TextDecoder().decode(frame)
  return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)) as Readonly<Record<string, unknown>>
}

const encodeFrame = (value: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

describe("NodeLanguageServer", () => {
  it("spawns through the protected spawner and performs framed JSON-RPC requests", async () => {
    const requests: Array<Readonly<Record<string, unknown>>> = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const spawner = ChildProcessSpawner.makeNoop({
            spawn: (command) =>
              Effect.gen(function*() {
                const standard = command as ChildProcess.StandardCommand
                expect(standard.command).toBe("typescript-language-server")
                expect(standard.args).toEqual(["--stdio"])
                expect(standard.options.cwd).toBe("/workspace")
                const stdinConfig = standard.options.stdin as ChildProcess.StdinConfig
                expect(Stream.isStream(stdinConfig.stream)).toBe(true)
                expect(stdinConfig.endOnDone).toBe(false)
                const stdin = stdinConfig.stream as Stream.Stream<Uint8Array>
                const output = yield* Queue.unbounded<Uint8Array>()
                yield* stdin.pipe(
                  Stream.runForEach((bytes) => {
                    const request = decodeFrame(bytes)
                    requests.push(request)
                    if (typeof request.id !== "number") return Effect.void
                    const response = request.method === "textDocument/hover"
                      ? { jsonrpc: "2.0", id: request.id, result: { contents: "hover result" } }
                      : { jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }
                    return Queue.offer(output, encodeFrame(response)).pipe(Effect.asVoid)
                  }),
                  Effect.forkScoped({ startImmediately: true })
                )
                return makeHandle({
                  pid: ProcessId(1),
                  exitCode: Effect.succeed(ExitCode(0)),
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: Stream.fromQueue(output),
                  stderr: Stream.empty,
                  all: Stream.fromQueue(output),
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void)
                })
              })
          })
          const server = yield* NodeLanguageServer.make({
            command: "typescript-language-server",
            args: ["--stdio"],
            cwd: "/workspace"
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
          return yield* Lsp.run({
            operation: "hover",
            path: "/workspace/a.ts",
            line: 2,
            character: 3
          }).pipe(Effect.provideService(LanguageServer.LanguageServer, server))
        })
      )
    )
    expect(result.result).toEqual({ contents: "hover result" })
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/hover"
    ])
    expect(requests[2]?.params).toMatchObject({
      position: { line: 1, character: 2 }
    })
  })
})
