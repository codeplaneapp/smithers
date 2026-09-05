import * as Install from "@smthrs/build/Install"
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runInstall } from "../src/engine.ts"

describe("install tier through the shipped CLI runtime", () => {
  it.skipIf(process.platform === "win32")(
    "executes non-cacheable link and reconciles again in a new invocation",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-install-tier-")))
      try {
        const executable = join(root, "manager.mjs")
        await copyFile(join(import.meta.dirname, "fixtures/install-tier-manager.mjs"), executable)
        await chmod(executable, 0o755)
        await writeFile(join(root, "package.json"), "{}\n")
        await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
        const options = {
          toolchain: {
            manager: "pnpm" as const,
            managerVersion: "11.21.0",
            managerExecutable: executable,
            runtime: "node" as const,
            runtimeVersion: process.versions.node,
            runtimeExecutable: process.execPath
          }
        }
        expect(Install.Link.tier).toBe("irreversible")
        const first = await runInstall(root, options)
        expect(first.result.linked).toBe(true)
        await writeFile(join(root, "node_modules/fixture.txt"), "corrupted\n")
        const second = await runInstall(root, options)
        expect(second.result).toEqual(first.result)
        expect(await readFile(join(root, "node_modules/fixture.txt"), "utf8")).toBe("installed\n")
        expect(await readFile(join(root, "manager-calls.txt"), "utf8")).toBe("fetch\ninstall\nfetch\ninstall\n")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
