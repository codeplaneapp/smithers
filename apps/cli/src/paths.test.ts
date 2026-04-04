import path from "node:path"

import { describe, expect, test } from "bun:test"

import {
  resolveCliEntrypointPath,
  resolveDaemonEntrypointPath,
  resolveWebDistPath,
} from "./paths"

describe("path resolution", () => {
  test("resolves daemon entrypoint inside apps/daemon", () => {
    expect(resolveDaemonEntrypointPath()).toEndWith(
      path.join("apps", "daemon", "src", "main.ts")
    )
  })

  test("resolves cli entrypoint inside apps/cli", () => {
    expect(resolveCliEntrypointPath()).toEndWith(path.join("apps", "cli", "src", "bin.ts"))
  })

  test("resolves bundled web build to top-level dist/web", () => {
    expect(resolveWebDistPath()).toEndWith(path.join("dist", "web"))
  })
})
