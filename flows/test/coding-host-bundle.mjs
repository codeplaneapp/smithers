/** Explicit native acceptance of the deployment bundler on the invoking runtime. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { bundle } from "../coding/build.mjs"

if (!process.env.PLUE_CODING_ADAPTER_SOURCE || !process.env.PLUE_JJ_EXPORT_BINARY) {
  throw new Error("Native bundle acceptance requires the provisioned Plue adapter source and exporter binary")
}
const temporary = await mkdtemp(join(tmpdir(), "smithers-host-bundle-"))
try {
  const output = join(temporary, "coding-host-native.test.mjs")
  await bundle(fileURLToPath(new URL("./coding-host-native.test.ts", import.meta.url)), output)
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.versions.bun ? "test" : "--test", output], {
      stdio: "inherit", env: { ...process.env, SMITHERS_ACCEPTANCE_SOURCE_ROOT: fileURLToPath(new URL("../", import.meta.url)) }
    })
    child.on("error", reject)
    child.on("exit", (code, signal) => signal ? reject(new Error(`Bundled host test exited on ${signal}`)) : resolve(code ?? 1))
  })
  process.exitCode = status
} finally {
  await rm(temporary, { recursive: true, force: true })
}
