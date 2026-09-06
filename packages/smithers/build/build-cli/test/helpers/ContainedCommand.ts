import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

export const until = async (check: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(10)
  }
  throw new Error("contained-command fixture did not reach its ready state")
}

interface Record {
  readonly token: string
  readonly pid: number
  readonly tick?: number
}

export const fixture = async (options: { readonly natural: boolean; readonly inheritedOutput: boolean }) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-build-child-"))
  const token = randomUUID()
  const beatPath = join(directory, "beat.json")
  const leaderPath = join(directory, "leader.json")
  const exitPath = join(directory, "exit")
  const read = async (path: string): Promise<Record | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record
    } catch {
      return undefined
    }
  }
  const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
    JSON.stringify(beatPath)
  };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,20)`
  const leader = `const fs=require('node:fs');const{spawn}=require('node:child_process');const token=${
    JSON.stringify(token)
  };fs.writeFileSync(${
    JSON.stringify(leaderPath)
  },JSON.stringify({token,pid:process.pid}));process.on('SIGTERM',()=>process.exit(0));spawn(process.execPath,['-e',${
    JSON.stringify(child)
  }],{stdio:${
    options.inheritedOutput ? "['ignore','inherit','inherit']" : "'ignore'"
  }}).unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(beatPath)})&&(${
    options.natural ? "true" : `fs.existsSync(${JSON.stringify(exitPath)})`
  }))process.stdout.write('target-complete\\n',()=>process.exit(0))},5)`
  return {
    directory,
    token,
    argv: [process.execPath, "-e", leader] as const,
    beat: () => read(beatPath),
    ready: () => until(async () => (await read(beatPath))?.token === token),
    exit: () => writeFile(exitPath, "go"),
    leader: () => read(leaderPath),
    stopped: (record: Record) => {
      const observed = identity(record.pid)
      return observed === "gone" || observed.startsWith("Z")
    },
    dispose: async () => {
      for (const path of [beatPath, leaderPath]) {
        const record = await read(path)
        // Only the unique process created by this fixture may be cleaned up.
        if (record?.token === token && identity(record.pid).includes(token)) {
          process.kill(record.pid, "SIGKILL")
          await until(async () => {
            const observed = identity(record.pid)
            return observed === "gone" || observed.startsWith("Z")
          })
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
}
