import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

const identity = (pid: number) => {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
    }).trim()
  } catch {
    return "gone"
  }
}

describe.skipIf(process.platform === "win32")("Exec natural process exit", () => {
  it.each([false, true])("reaps a late child after target exit (inherited output: %s)", async (inheritedOutput) => {
    const directory = await mkdtemp(join(tmpdir(), "smithers-exec-child-"))
    const token = randomUUID()
    const beatPath = join(directory, "beat.json")
    const read = async (): Promise<
      { readonly token: string; readonly pid: number; readonly tick: number } | undefined
    > => {
      try {
        return JSON.parse(await readFile(beatPath, "utf8"))
      } catch {
        return undefined
      }
    }
    const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
      JSON.stringify(beatPath)
    };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,20)`
    const leader = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${
      JSON.stringify(child)
    }],{stdio:${
      inheritedOutput ? "['ignore','inherit','inherit']" : "'ignore'"
    }}).unref();setInterval(()=>{if(fs.existsSync(${
      JSON.stringify(beatPath)
    }))process.stdout.write('target-complete\\n',()=>process.exit(0))},5)`
    try {
      const result = await Effect.runPromise(Exec.run({ workspaceRoot: directory }, {
        cwd: ".",
        argv: [process.execPath, "-e", leader],
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 5000
      }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("target-complete\n")
      const first = await read()
      expect(first?.token).toBe(token)
      const observed = identity(first!.pid)
      expect(observed === "gone" || observed.startsWith("Z")).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(await read()).toEqual(first)
    } finally {
      const owned = await read()
      if (owned?.token === token && identity(owned.pid).includes(token)) {
        process.kill(owned.pid, "SIGKILL")
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const observed = identity(owned.pid)
          if (observed === "gone" || observed.startsWith("Z")) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})
