import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option, PlatformError, Stream } from "effect"
import * as JustBashSandbox from "../src/JustBashSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const normalize = (raw: string): string => {
  const parts: Array<string> = []
  for (const part of `/${raw}`.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const parentOf = (path: string): string => {
  const normalized = normalize(path)
  const separator = normalized.lastIndexOf("/")
  return separator === 0 ? "/" : normalized.slice(0, separator)
}

const platformFailure = (
  method: string,
  path: string,
  tag: PlatformError.SystemErrorTag = "NotFound"
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    description: `${tag}: ${path}`,
    pathOrDescriptor: path
  })

const info = (type: FileSystem.File.Type, size = 0): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(size),
  blksize: Option.none(),
  blocks: Option.none()
})

const memoryFileSystem = () => {
  const directories = new Set<string>(["/"])
  const files = new Map<string, Uint8Array>()
  const links = new Map<string, string>()

  const linkTarget = (path: string): string | undefined => {
    const normalized = normalize(path)
    const target = links.get(normalized)
    if (target === undefined) return undefined
    return normalize(target.startsWith("/") ? target : `${parentOf(normalized)}/${target}`)
  }

  const resolved = (path: string): string => {
    const normalized = normalize(path)
    return linkTarget(normalized) ?? normalized
  }

  const entryPaths = (): Array<string> => [
    ...directories,
    ...files.keys(),
    ...links.keys()
  ]

  const fs = FileSystem.makeNoop({
    access: (path) =>
      Effect.suspend(() => {
        const target = resolved(path)
        return directories.has(target) || files.has(target)
          ? Effect.void
          : Effect.fail(platformFailure("access", path))
      }),
    exists: (path) =>
      Effect.sync(() => {
        const target = resolved(path)
        return directories.has(target) || files.has(target)
      }),
    makeDirectory: (path, options) =>
      Effect.suspend(() => {
        const target = normalize(path)
        if (files.has(target) || links.has(target)) {
          return Effect.fail(platformFailure("makeDirectory", path, "AlreadyExists"))
        }
        if (directories.has(target)) {
          return options?.recursive === true
            ? Effect.void
            : Effect.fail(platformFailure("makeDirectory", path, "AlreadyExists"))
        }
        if (options?.recursive !== true && !directories.has(parentOf(target))) {
          return Effect.fail(platformFailure("makeDirectory", path))
        }
        let current = ""
        for (const part of target.split("/").filter(Boolean)) {
          current += `/${part}`
          if (files.has(current) || links.has(current)) {
            return Effect.fail(platformFailure("makeDirectory", current, "AlreadyExists"))
          }
        }
        return Effect.sync(() => {
          let directory = ""
          for (const part of target.split("/").filter(Boolean)) {
            directory += `/${part}`
            directories.add(directory)
          }
        })
      }),
    readFile: (path) =>
      Effect.suspend(() => {
        const target = resolved(path)
        if (directories.has(target)) {
          return Effect.fail(platformFailure("readFile", path, "BadResource"))
        }
        const content = files.get(target)
        return content === undefined
          ? Effect.fail(platformFailure("readFile", path))
          : Effect.succeed(content.slice())
      }),
    readFileString: (path) => Effect.map(fs.readFile(path), (content) => decoder.decode(content)),
    writeFile: (path, content) =>
      Effect.suspend(() => {
        const target = resolved(path)
        if (directories.has(target)) {
          return Effect.fail(platformFailure("writeFile", path, "BadResource"))
        }
        if (!directories.has(parentOf(target))) {
          return Effect.fail(platformFailure("writeFile", path))
        }
        return Effect.sync(() => {
          files.set(target, content.slice())
        })
      }),
    writeFileString: (path, content) => fs.writeFile(path, encoder.encode(content)),
    stat: (path) =>
      Effect.suspend(() => {
        const target = resolved(path)
        if (directories.has(target)) return Effect.succeed(info("Directory"))
        const content = files.get(target)
        return content === undefined
          ? Effect.fail(platformFailure("stat", path))
          : Effect.succeed(info("File", content.length))
      }),
    readDirectory: (path, options) =>
      Effect.suspend(() => {
        const target = resolved(path)
        if (!directories.has(target)) return Effect.fail(platformFailure("readDirectory", path))
        const prefix = target === "/" ? "/" : `${target}/`
        const entries = new Set<string>()
        for (const entry of entryPaths()) {
          if (entry === target || !entry.startsWith(prefix)) continue
          const relative = entry.slice(prefix.length)
          entries.add(options?.recursive === true ? relative : relative.split("/")[0]!)
        }
        return Effect.succeed([...entries].sort())
      }),
    remove: (path, options) =>
      Effect.suspend(() => {
        const target = normalize(path)
        const present = files.has(target) || links.has(target) || directories.has(target)
        if (!present) {
          return options?.force === true ? Effect.void : Effect.fail(platformFailure("remove", path))
        }
        const prefix = `${target}/`
        const hasChildren = entryPaths().some((entry) => entry.startsWith(prefix))
        if (directories.has(target) && hasChildren && options?.recursive !== true) {
          return Effect.fail(platformFailure("remove", path, "Busy"))
        }
        return Effect.sync(() => {
          for (const entry of [...files.keys()]) {
            if (entry === target || entry.startsWith(prefix)) files.delete(entry)
          }
          for (const entry of [...links.keys()]) {
            if (entry === target || entry.startsWith(prefix)) links.delete(entry)
          }
          for (const entry of [...directories]) {
            if (entry === target || entry.startsWith(prefix)) directories.delete(entry)
          }
        })
      }),
    rename: (oldPath, newPath) =>
      Effect.suspend(() => {
        const oldTarget = normalize(oldPath)
        const newTarget = normalize(newPath)
        if (!files.has(oldTarget) && !links.has(oldTarget) && !directories.has(oldTarget)) {
          return Effect.fail(platformFailure("rename", oldPath))
        }
        if (!directories.has(parentOf(newTarget))) {
          return Effect.fail(platformFailure("rename", newPath))
        }
        return Effect.sync(() => {
          const move = <A>(entries: Map<string, A>): void => {
            for (const [path, value] of [...entries]) {
              if (path !== oldTarget && !path.startsWith(`${oldTarget}/`)) continue
              entries.delete(path)
              entries.set(`${newTarget}${path.slice(oldTarget.length)}`, value)
            }
          }
          move(files)
          move(links)
          for (const path of [...directories]) {
            if (path !== oldTarget && !path.startsWith(`${oldTarget}/`)) continue
            directories.delete(path)
            directories.add(`${newTarget}${path.slice(oldTarget.length)}`)
          }
        })
      }),
    symlink: (fromPath, toPath) =>
      Effect.suspend(() => {
        const target = normalize(toPath)
        if (files.has(target) || directories.has(target) || links.has(target)) {
          return Effect.fail(platformFailure("symlink", toPath, "AlreadyExists"))
        }
        if (!directories.has(parentOf(target))) {
          return Effect.fail(platformFailure("symlink", toPath))
        }
        return Effect.sync(() => {
          links.set(target, fromPath)
        })
      }),
    readLink: (path) =>
      Effect.suspend(() => {
        const target = links.get(normalize(path))
        return target === undefined
          ? Effect.fail(platformFailure("readLink", path))
          : Effect.succeed(target)
      }),
    realPath: (path) =>
      Effect.suspend(() => {
        const target = resolved(path)
        return directories.has(target) || files.has(target)
          ? Effect.succeed(target)
          : Effect.fail(platformFailure("realPath", path))
      })
  })

  return { fs }
}

const shellWords = (line: string): Array<string> => {
  const words: Array<string> = []
  let word = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  let started = false
  for (const character of line.trim()) {
    if (escaped) {
      word += character
      escaped = false
      started = true
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else word += character
      started = true
    } else if (character === "'" || character === "\"") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word)
        word = ""
        started = false
      }
    } else {
      word += character
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

const base64 = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += alphabet[first >> 2]
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)]
    output += second === undefined ? "=" : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)]
    output += third === undefined ? "=" : alphabet[third & 63]
  }
  return output
}

interface BashCall {
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

const justBash = (fs: FileSystem.FileSystem) => {
  const calls: Array<BashCall> = []
  const result = (stdout = "", stderr = "", exitCode = 0) => ({ stdout, stderr, exitCode })

  const attempt = async <A>(effect: Effect.Effect<A, PlatformError.PlatformError>): Promise<A | undefined> => {
    try {
      return await Effect.runPromise(effect)
    } catch {
      return undefined
    }
  }

  const run: JustBashSandbox.JustBashLike["run"] = async (command, options = {}) => {
    const cwd = normalize(options.cwd ?? "/")
    const env = options.env ?? {}
    calls.push({ command, cwd, env })
    const absolute = (path: string): string => normalize(path.startsWith("/") ? path : `${cwd}/${path}`)

    if (command === "pwd") return result(`${cwd}\n`)
    if (command === "printf 'out'; printf 'err' >&2; exit 4") return result("out", "err", 4)

    if (command.startsWith("if [ -d ") && command.includes("t=Directory")) {
      const target = absolute(shellWords(command.slice(8, command.indexOf(" ]; then")))[0]!)
      const stats = await attempt(fs.stat(target))
      if (stats !== undefined) return result(`${stats.type} ${stats.type === "File" ? stats.size : 0n}`)
      if (await attempt(fs.readLink(target)) !== undefined) return result("SymbolicLink 0")
      return result("", "", 9)
    }

    if (command.startsWith("if [ -d ") && (command.includes("; then find ") || command.includes("; then ls "))) {
      const target = absolute(shellWords(command.slice(8, command.indexOf(" ]; then")))[0]!)
      const stats = await attempt(fs.stat(target))
      if (stats?.type !== "Directory") return result("", "", 9)
      const recursive = command.includes("; then find ")
      const entries = await Effect.runPromise(fs.readDirectory(target, { recursive }))
      const output = recursive ? entries.map((entry) => `${target}/${entry}`) : entries
      return result(output.length === 0 ? "" : `${output.join("\n")}\n`)
    }

    if (command.startsWith("if [ -e ") && command.includes("; then rm ")) {
      const target = absolute(shellWords(command.slice(8, command.indexOf(" ] ||")))[0]!)
      const exists = await Effect.runPromise(fs.exists(target))
      const link = await attempt(fs.readLink(target)) !== undefined
      if (!exists && !link) return result("", "", 9)
      command = command.slice(command.indexOf("then ") + 5, command.indexOf("; else"))
    }

    const words = shellWords(command)
    const program = words[0]
    try {
      if (program === "exit") return result("", "", Number(words[1] ?? 0))
      if (program === "printf") {
        const format = words[1] ?? ""
        const values = words.slice(2).map((value) => {
          const variable = /^\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value)
          const name = variable?.[1] ?? variable?.[2]
          return name === "PWD" ? cwd : name === undefined ? value : env[name] ?? ""
        })
        let index = 0
        return result(format.replaceAll("%s", () => values[index++] ?? ""))
      }
      if (program === "test") {
        const flag = words[1]
        const target = absolute(words[2]!)
        if (flag === "-h") return result("", "", await attempt(fs.readLink(target)) === undefined ? 1 : 0)
        const stats = await attempt(fs.stat(target))
        const passes = flag === "-e"
          ? stats !== undefined
          : flag === "-d"
          ? stats?.type === "Directory"
          : stats?.type === "File"
        return result("", "", passes ? 0 : 1)
      }
      if (program === "cat") {
        const content = await Effect.runPromise(fs.readFile(absolute(words[1]!)))
        return result(decoder.decode(content))
      }
      if (program === "base64") {
        const content = await Effect.runPromise(fs.readFile(absolute(words[1]!)))
        return result(`${base64(content)}\n`)
      }
      if (program === "wc" && words[1] === "-c" && words[2] === "<") {
        const content = await Effect.runPromise(fs.readFile(absolute(words[3]!)))
        return result(`${content.length}\n`)
      }
      if (program === "mkdir") {
        const recursive = words.includes("-p")
        await Effect.runPromise(fs.makeDirectory(absolute(words.at(-1)!), { recursive }))
        return result()
      }
      if (program === "ls") {
        const entries = await Effect.runPromise(fs.readDirectory(absolute(words.at(-1)!)))
        return result(entries.length === 0 ? "" : `${entries.join("\n")}\n`)
      }
      if (program === "find") {
        const target = absolute(words[1]!)
        const entries = await Effect.runPromise(fs.readDirectory(target, { recursive: true }))
        return result(entries.length === 0 ? "" : `${entries.map((entry) => `${target}/${entry}`).join("\n")}\n`)
      }
      if (program === "rm") {
        await Effect.runPromise(fs.remove(absolute(words.at(-1)!), {
          recursive: words.includes("-r"),
          force: words.includes("-f")
        }))
        return result()
      }
      if (program === "mv") {
        await Effect.runPromise(fs.rename(absolute(words[1]!), absolute(words[2]!)))
        return result()
      }
      if (program === "readlink") {
        const canonical = words[1] === "-f"
        const target = absolute(words[canonical ? 2 : 1]!)
        const answer = canonical
          ? await Effect.runPromise(fs.realPath(target))
          : await Effect.runPromise(fs.readLink(target))
        return result(`${answer}\n`)
      }
    } catch (error) {
      return result("", `${program}: ${String(error)}\n`, 1)
    }
    return result("", `${program}: command not found\n`, 127)
  }

  return { bash: { run } satisfies JustBashSandbox.JustBashLike, calls }
}

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.flatMap(session.spawn(command, options), (process) =>
      Effect.map(
        Effect.all([
          Stream.mkString(Stream.decodeText(process.stdout)),
          Stream.mkString(Stream.decodeText(process.stderr)),
          process.exitCode
        ]),
        ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })
      ))
  )

describe("JustBashSandbox", () => {
  it.effect("passes SandboxConformance against a shared in-memory tree", () =>
    Effect.gen(function*() {
      const memory = memoryFileSystem()
      const fake = justBash(memory.fs)
      const provider = JustBashSandbox.make({ bash: fake.bash, fs: memory.fs })
      const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
      expect(violations).toEqual([])
      expect(fake.calls.some((call) => call.cwd.startsWith("/workspace/sandbox-conformance-"))).toBe(true)
      expect(fake.calls.find((call) => call.env.SANDBOX_CONFORMANCE === "delivered")?.env).toEqual({
        SANDBOX_CONFORMANCE: "delivered"
      })
    }))

  it.effect("shares files with the interpreter and serves rooted native and probe operations", () =>
    Effect.gen(function*() {
      const memory = memoryFileSystem()
      const fake = justBash(memory.fs)
      const provider = JustBashSandbox.make({ bash: fake.bash, fs: memory.fs, root: "/virtual///" })
      let released = ""
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("shared/tree")
          released = session.workdir
          expect(session.remoteId).toBe(session.workdir)
          expect(session.workdir.startsWith("/virtual/")).toBe(true)
          expect(session.kill).toBeUndefined()
          yield* session.ping!

          const binary = new Uint8Array([0, 1, 2, 255, 254])
          yield* session.writeFile(`${session.workdir}/deep/data.bin`, binary)
          expect(Array.from(yield* session.readFile(`${session.workdir}/deep/data.bin`))).toEqual([...binary])
          expect((yield* output(session, `base64 ${session.workdir}/deep/data.bin`)).stdout).toBe("AAEC//4=\n")
          expect((yield* output(session, `wc -c < ${session.workdir}/deep/data.bin`)).stdout).toBe("5\n")

          yield* session.writeFile(`${session.workdir}/notes/agenda.txt`, encoder.encode("prepared"))
          expect((yield* output(session, `cat ${session.workdir}/notes/agenda.txt`)).stdout).toBe("prepared")
          expect((yield* output(session, "pwd", { cwd: "/virtual" })).stdout).toBe("/virtual\n")
          const env = yield* output(session, `printf '%s:%s' "$KEPT" "$DROPPED"`, {
            env: { KEPT: "yes", DROPPED: undefined }
          })
          expect(env.stdout).toBe("yes:")
          expect(fake.calls.at(-1)?.env).toEqual({ KEPT: "yes" })

          const replayed = yield* output(session, "printf 'out'; printf 'err' >&2; exit 4")
          expect(replayed).toEqual({ stdout: "out", stderr: "err", exitCode: 4 })
          expect(
            yield* Stream.runCollect(
              (yield* session.spawn("exit 0", {})).stdout
            )
          ).toEqual([])

          const probed = Sandbox.fileSystem({ ...session, files: undefined })
          yield* memory.fs.symlink(
            `${session.workdir}/notes/agenda.txt`,
            `${session.workdir}/notes/link.txt`
          )
          expect(yield* probed.exists(`${session.workdir}/notes/agenda.txt`)).toBe(true)
          expect(yield* probed.exists(`${session.workdir}/missing`)).toBe(false)
          expect((yield* probed.stat(`${session.workdir}/notes/agenda.txt`)).size).toBe(8n)
          expect((yield* probed.stat(`${session.workdir}/notes`)).type).toBe("Directory")
          expect(yield* probed.readDirectory(`${session.workdir}/notes`)).toEqual(["agenda.txt", "link.txt"])
          expect(yield* probed.readDirectory(session.workdir, { recursive: true })).toEqual([
            "deep",
            "deep/data.bin",
            "notes",
            "notes/agenda.txt",
            "notes/link.txt"
          ])
          expect(yield* probed.readLink(`${session.workdir}/notes/link.txt`)).toBe(
            `${session.workdir}/notes/agenda.txt`
          )
          expect(yield* probed.realPath(`${session.workdir}/notes/link.txt`)).toBe(
            `${session.workdir}/notes/agenda.txt`
          )
          yield* probed.makeDirectory(`${session.workdir}/build/out`, { recursive: true })
          yield* probed.rename(
            `${session.workdir}/notes/agenda.txt`,
            `${session.workdir}/build/out/agenda.txt`
          )
          yield* probed.remove(`${session.workdir}/notes`, { recursive: true, force: true })

          const native = Sandbox.fileSystem(session)
          yield* native.writeFileString("relative.txt", "rooted")
          expect((yield* native.stat("./relative.txt")).type).toBe("File")
          expect(yield* native.exists("")).toBe(true)
          expect(yield* native.exists(".")).toBe(true)
          expect(yield* native.exists(`${session.workdir}/relative.txt`)).toBe(true)
          yield* native.makeDirectory("native/dir", { recursive: true })
          yield* native.rename("relative.txt", "native/dir/moved.txt")
          expect(yield* native.readDirectory(".")).toContain("native")
          yield* memory.fs.symlink("native/dir/moved.txt", `${session.workdir}/native-link`)
          expect(yield* native.readLink("native-link")).toBe("native/dir/moved.txt")
          expect(yield* native.realPath("native-link")).toBe(`${session.workdir}/native/dir/moved.txt`)
          yield* native.remove("native", { recursive: true })
          expect(yield* native.exists("native")).toBe(false)

          yield* session.writeFile("/top-level.bin", new Uint8Array([9]))
          expect(Array.from(yield* memory.fs.readFile("/top-level.bin"))).toEqual([9])
        })
      )
      expect(yield* memory.fs.exists(released)).toBe(false)
    }))

  it.effect("keeps colliding keys separate and tears both workspaces down", () =>
    Effect.gen(function*() {
      const memory = memoryFileSystem()
      const fake = justBash(memory.fs)
      const provider = JustBashSandbox.make({ bash: fake.bash, fs: memory.fs })
      const workdirs = yield* Effect.scoped(
        Effect.gen(function*() {
          const one = yield* provider.acquire("lane/one")
          const other = yield* provider.acquire("lane-one")
          expect(one.workdir).not.toBe(other.workdir)
          yield* one.writeFile(`${one.workdir}/proof.txt`, encoder.encode("one"))
          expect(yield* memory.fs.exists(`${other.workdir}/proof.txt`)).toBe(false)
          return [one.workdir, other.workdir]
        })
      )
      for (const workdir of workdirs) expect(yield* memory.fs.exists(workdir)).toBe(false)
    }))

  it.effect("maps interpreter and filesystem failures into the provider vocabulary", () =>
    Effect.gen(function*() {
      const memory = memoryFileSystem()
      const refusal = platformFailure("test", "/refused", "PermissionDenied")
      const refusingFs = FileSystem.makeNoop({
        ...memory.fs,
        readFile: (path) => path.endsWith("locked") ? Effect.fail(refusal) : memory.fs.readFile(path),
        writeFile: (path, content) =>
          path.endsWith("refused") ? Effect.fail(refusal) : memory.fs.writeFile(path, content)
      })
      const fake = justBash(refusingFs)
      const provider = JustBashSandbox.make({ bash: fake.bash, fs: refusingFs })
      const failures = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("failures")
          const absent = yield* Effect.flip(session.readFile(`${session.workdir}/absent`))
          const locked = yield* Effect.flip(session.readFile(`${session.workdir}/locked`))
          const write = yield* Effect.flip(session.writeFile(`${session.workdir}/refused`, new Uint8Array([1])))
          return { absent, locked, write }
        })
      )
      expect((failures.absent as ProviderError).code).toBe("not_found")
      expect((failures.locked as ProviderError).code).toBe("unknown")
      expect((failures.write as ProviderError).code).toBe("unknown")

      const brokenBash: JustBashSandbox.JustBashLike = {
        run: () => Promise.reject(new Error("interpreter crashed"))
      }
      const spawnFailure = yield* Effect.flip(
        Effect.scoped(
          Effect.flatMap(
            JustBashSandbox.make({ bash: brokenBash, fs: memory.fs }).acquire("broken-bash"),
            (session) => Effect.scoped(Effect.asVoid(session.spawn("true", {})))
          )
        )
      )
      expect((spawnFailure as ProviderError).code).toBe("spawn_error")

      const unavailableFs = FileSystem.makeNoop({
        makeDirectory: () => Effect.fail(refusal),
        remove: () => Effect.void
      })
      const acquireFailure = yield* Effect.flip(
        Effect.scoped(
          JustBashSandbox.make({ bash: fake.bash, fs: unavailableFs }).acquire("unavailable")
        )
      )
      expect((acquireFailure as ProviderError).code).toBe("unavailable")
    }))
})
