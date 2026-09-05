import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("the real package gate fails before collection when its required WASM artifact is missing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flows-jj-missing-artifact-")))
  try {
    await mkdir(join(root, "test"))
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "junction")
    await writeFile(
      join(root, "test", "Sentinel.test.ts"),
      "import { it } from \"vitest\"\nit(\"sentinel reached\", () => {})\n"
    )
    const run = () =>
      promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
        "run",
        "--config",
        fileURLToPath(new URL("../vitest.config.ts", import.meta.url)),
        "--root",
        root,
        "--maxWorkers=1",
        "--coverage.enabled=false"
      ], { cwd: root, timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } })
    const command = run()
    await expect(command).rejects.toMatchObject({ code: 1 })
    const failure = await command.catch((cause: { stdout: string; stderr: string }) => cause)
    const output = failure.stdout + failure.stderr
    expect(output).toContain(`Required jj WASM artifact is missing: ${join(root, "wasm", "flows_jj.wasm")}`)
    expect(output).toContain("The conformance gate cannot run.")
    expect(output).not.toContain("1 passed")
    // Positive control: the identical config, fixture and invocation can pass
    // once its required artifact is present. Never move the committed bytes.
    await mkdir(join(root, "wasm"))
    await copyFile(new URL("../wasm/flows_jj.wasm", import.meta.url), join(root, "wasm", "flows_jj.wasm"))
    const passed = await run()
    expect(passed.stdout).toContain("1 passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
