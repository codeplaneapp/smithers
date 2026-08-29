/**
 * The contract's other half: a bundle that provides every tag in the closed
 * Host list and supports none of them.
 *
 * `NodeHost`, `BunHost`, `BrowserHost`, and `TestHost` between them declare
 * almost everything as supported, so the suite's "declared unsupported" arm —
 * and the three error shapes `errorCode` has to normalize — would otherwise go
 * unasserted. A serverless or locked-down bundle looks exactly like this.
 */
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Effect, Layer, Path, PlatformError } from "effect"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CommandLine from "../../src/CommandLine.ts"
import * as HttpClient from "../../src/HttpClient.ts"
import { runHostContract } from "./HostContract.ts"

/**
 * A bundle with no way to start a process still provides the tag; it just
 * fails every spawn in the error channel, the way a Smithers service reports an
 * unsupported capability.
 */
const layerSpawnerUnsupported: Layer.Layer<ChildProcessSpawner> = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "UnsupportedHost",
        method: "spawn",
        description: `no process host for \`${CommandLine.render(command)}\``
      })
    )
  )
)

const rejecting = (): BrowserFileSystem.ZenFsPromisesLike => {
  const denied = () => Promise.reject(new Error("filesystem is unavailable on this host"))
  return {
    open: denied,
    readFile: denied,
    writeFile: denied,
    mkdir: denied,
    readdir: denied,
    stat: denied,
    rm: denied
  }
}

const basePath = Effect.runSync(Effect.provide(Path.Path, Path.layer))

/** A `Path` that has no file URL scheme to resolve, the way a VFS host does. */
const layerPathUnsupported: Layer.Layer<Path.Path> = Layer.succeed(Path.Path)({
  ...basePath,
  fromFileUrl: () => {
    throw { _tag: "NoFileUrls" }
  }
})

runHostContract(
  "UnsupportedHost",
  Layer.mergeAll(
    BrowserFileSystem.layer(rejecting()),
    layerPathUnsupported,
    layerSpawnerUnsupported,
    BrowserJj.layerUnsupported,
    HttpClient.layerNoop()
  ),
  {
    // A `PlatformError` carries its code as `reason._tag`.
    fileSystem: { expected: "failure", code: "Unknown" },
    // A thrown tagged value carries it as a bare `_tag`.
    path: { expected: "failure", code: "NoFileUrls" },
    childProcess: { expected: "failure", code: "NotFound" },
    jj: { expected: "failure", code: "not_installed" },
    httpClient: { expected: "failure", code: "TransportError" }
  }
)
