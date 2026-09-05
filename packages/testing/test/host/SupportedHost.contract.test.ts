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
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { runHostContract } from "@smthrs/kernel/test/contract"
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
import { makeMemoryFs } from "../../src/TestHost.ts"

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
      const rendered = CommandLine.render(command)
      const pending = rendered.includes("sleep 10")
      let running = pending
      if (pending) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            running = false
          })
        )
      }
      const text = piped ?? environment ?? printf ??
        (command._tag === "PipedCommand" ? "host-contract-pipeline" : "")
      const stdout = text === "" ? Stream.empty : Stream.fromArray([encoder.encode(text)])
      return makeHandle({
        pid: ProcessId(1),
        exitCode: pending ? Effect.never : Effect.succeed(ExitCode(0)),
        isRunning: Effect.sync(() => running),
        kill: () =>
          Effect.sync(() => {
            running = false
          }),
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

let nextChange = 0
const layerJjSupported: Layer.Layer<Jj> = Layer.succeed(JjService.Jj)(
  JjService.makeNoop({
    snapshot: () => Effect.succeed({ changeId: `change-${++nextChange}` }),
    restore: () => Effect.void,
    diff: () => Effect.succeed("diff"),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("The working copy is clean"),
    root: () => Effect.succeed("/host-contract"),
    revert: () => Effect.succeed({ reverted: ["host-contract.txt"] })
  })
)

const layerJjPartial: Layer.Layer<Jj> = Layer.succeed(JjService.Jj)(
  JjService.makeNoop({
    snapshot: () => Effect.succeed({ changeId: `partial-${++nextChange}` }),
    restore: () => Effect.void,
    diff: () => Effect.succeed("diff"),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("The working copy is clean"),
    root: () => Effect.fail(JjService.jjError({ code: "not_installed", method: "root" })),
    revert: () => Effect.fail(JjService.jjError({ code: "not_installed", method: "revert" }))
  })
)

/** A client that answers without a socket, so the success arm is asserted. */
const layerHttpClientSupported: Layer.Layer<EffectHttpClient.HttpClient> = Layer.succeed(
  EffectHttpClient.HttpClient
)(
  EffectHttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed({
      status: request.url.endsWith("/redirect") ? 302 : 200,
      headers: {
        "x-host-contract": request.method,
        ...(request.url.endsWith("/redirect") ? { location: "/destination" } : {})
      },
      request
    } as never)
  )
)

const fileSystemCaps = {
  expected: "success",
  unsupported: {
    chmod: "PermissionDenied",
    chown: "PermissionDenied",
    copy: "PermissionDenied",
    copyFile: "PermissionDenied",
    glob: "PermissionDenied",
    link: "PermissionDenied",
    makeTempDirectory: "PermissionDenied",
    makeTempDirectoryScoped: "PermissionDenied",
    makeTempFile: "PermissionDenied",
    makeTempFileScoped: "PermissionDenied",
    open: "PermissionDenied",
    readLink: "PermissionDenied",
    rename: "PermissionDenied",
    sink: "PermissionDenied",
    symlink: "PermissionDenied",
    truncate: "PermissionDenied",
    utimes: "PermissionDenied",
    watch: "PermissionDenied"
  }
} as const

const httpClientCaps = {
  expected: "success",
  read: {
    request: HttpClientRequest.get("https://example.test/host-contract/read"),
    assertResponse: (response: HttpClientResponse.HttpClientResponse) => {
      expect(response.status).toBe(200)
      expect(response.headers["x-host-contract"]).toBe("GET")
    }
  },
  write: {
    request: HttpClientRequest.post("https://example.test/host-contract/write").pipe(
      HttpClientRequest.bodyText("host-contract")
    ),
    assertResponse: (response: HttpClientResponse.HttpClientResponse) => {
      expect(response.status).toBe(200)
      expect(response.headers["x-host-contract"]).toBe("POST")
    }
  },
  redirect: {
    request: HttpClientRequest.get("https://example.test/host-contract/redirect"),
    assertResponse: (response: HttpClientResponse.HttpClientResponse) => {
      expect(response.status).toBe(302)
      expect(response.headers.location).toBe("/destination")
    }
  }
} as const

const layerWithoutJj = Layer.mergeAll(
  BrowserFileSystem.layer(makeMemoryFs()),
  Path.layer,
  layerSpawnerSupported,
  layerHttpClientSupported
)

runHostContract(
  "SupportedHost",
  Layer.merge(layerWithoutJj, layerJjSupported),
  {
    // Every capability below takes the suite's defaults on purpose.
    fileSystem: fileSystemCaps,
    path: { expected: "success" },
    childProcess: { expected: "success" },
    jj: { expected: "success" },
    httpClient: httpClientCaps
  }
)

runHostContract(
  "SupportedHost with optional Jj refusals",
  Layer.merge(layerWithoutJj, layerJjPartial),
  {
    fileSystem: fileSystemCaps,
    path: { expected: "success" },
    childProcess: { expected: "success" },
    jj: {
      expected: "success",
      prepareChange: () => Effect.void,
      workspacePath: "/explicit-jj-workspace",
      rootFrom: "/explicit-jj-root",
      unsupported: { root: "not_installed", revert: "not_installed" }
    },
    httpClient: httpClientCaps
  }
)
