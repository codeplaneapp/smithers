/**
 * The contract's success arm, in the kernel's own package.
 *
 * `TestHost` and `UnsupportedHost` between them declare almost everything as
 * unsupported — a scripted interpreter takes no stdin, and a browser-shaped
 * bundle has no jj and no network — so the suite's "declared supported"
 * branches for stdin, Jj, and HttpClient would otherwise go unasserted
 * here. The real bundles that exercise them live in `@smthrs/platform-node`
 * and `@smthrs/platform-bun`, which the kernel must not depend on: a
 * capability kernel that needed a platform package to be tested would not be
 * a kernel.
 *
 * So this bundle answers every capability successfully, with the smallest
 * doubles that can. It pins the suite, not any platform.
 *
 * It also takes **every default the suite offers** — no `execCommand`, no
 * `scratchPath`. Those `??` fallbacks are the suite's own contract with an
 * adapter author who declares nothing, and the only other bundle that
 * exercised them (`NodeHostDefaults`) now lives in `@smthrs/platform-node`.
 * A default nobody runs is a default nobody has checked.
 */
import * as JjService from "@smthrs/jj"
import type { Jj } from "@smthrs/jj"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Effect, Layer, Path, Sink, Stream } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { expect } from "vitest"
import * as CommandLine from "../../src/CommandLine.ts"
import { makeMemoryFs } from "../../src/test/TestHost.ts"
import { runHostContract } from "./HostContract.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * A spawner that *can* pipe stdin, which is the whole point of this bundle.
 *
 * It emulates the three default probes rather than matching their exact
 * rendered text: a command fed a `stdin` stream echoes it, a command carrying
 * `HOST_CONTRACT_ENV` echoes that, and `printf` echoes its arguments. Anything
 * else is silent. Everything about the handle is the smallest thing that
 * satisfies `ChildProcessHandle`.
 */
const layerSpawnerSupported: Layer.Layer<ChildProcessSpawner> = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command) =>
    Effect.gen(function*() {
      const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined
      const piped = Stream.isStream(stdin)
        ? Array.from(yield* Stream.runCollect(stdin), (chunk) => decoder.decode(chunk)).join("").trimEnd()
        : undefined
      const environment = CommandLine.env(command)?.["HOST_CONTRACT_ENV"]
      const printf = command._tag === "StandardCommand" && command.command === "printf"
        ? command.args.join(" ")
        : undefined
      const text = piped ?? environment ?? printf ?? ""
      const stdout = text === "" ? Stream.empty : Stream.fromArray([encoder.encode(text)])
      return makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
)

const layerJjSupported: Layer.Layer<Jj> = Layer.succeed(JjService.Jj)(
  JjService.makeNoop({ status: () => Effect.succeed("The working copy is clean") })
)

/** A client that answers without a socket, so the success arm is asserted. */
const layerHttpClientSupported: Layer.Layer<EffectHttpClient.HttpClient> = Layer.succeed(
  EffectHttpClient.HttpClient
)(
  EffectHttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed({ status: 200, headers: { "x-host-contract": "echo" }, request } as never)
  )
)

runHostContract(
  "SupportedHost",
  Layer.mergeAll(
    BrowserFileSystem.layer(makeMemoryFs()),
    Path.layer,
    layerSpawnerSupported,
    layerJjSupported,
    layerHttpClientSupported
  ),
  {
    // Every capability below takes the suite's defaults on purpose.
    fileSystem: {
      expected: "success",
      unsupported: {
        chmod: "NotFound",
        chown: "NotFound",
        copy: "NotFound",
        copyFile: "NotFound",
        glob: "NotFound",
        link: "NotFound",
        makeTempDirectory: "NotFound",
        makeTempDirectoryScoped: "NotFound",
        makeTempFile: "NotFound",
        makeTempFileScoped: "NotFound",
        open: "NotFound",
        readLink: "NotFound",
        rename: "NotFound",
        sink: "NotFound",
        symlink: "NotFound",
        truncate: "NotFound",
        utimes: "NotFound",
        watch: "NotFound"
      }
    },
    path: { expected: "success" },
    childProcess: { expected: "success" },
    jj: { expected: "success" },
    httpClient: {
      expected: "success",
      request: HttpClientRequest.get("https://example.test/host-contract"),
      assertResponse: (response: HttpClientResponse.HttpClientResponse) => {
        expect(response.status).toBe(200)
        expect(response.headers["x-host-contract"]).toBe("echo")
      }
    }
  }
)
