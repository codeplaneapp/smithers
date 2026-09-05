import { statSync } from "node:fs"
import { join } from "node:path"
import type { TestProject } from "vitest/node"

/** All selections using the supported package config require the real artifact. */
export default function requireWasm({ config }: TestProject): void {
  const path = join(config.root, "wasm", "flows_jj.wasm")
  try {
    if (!statSync(path).isFile()) throw new Error("artifact is not a regular file")
  } catch (cause) {
    throw new Error(`Required jj WASM artifact is missing: ${path}. The conformance gate cannot run.`, { cause })
  }
}
