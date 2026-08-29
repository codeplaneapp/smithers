import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Sink, Stream } from "effect"
import * as Path from "effect/Path"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"

const root = mkdtempSync(join(tmpdir(), "flows-search-conformance-"))
const file = (relative: string, content: string | Uint8Array): void => {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

// A directory the process may not list belongs in its own root: every search
// rooted above it would otherwise depend on the same skip, and a filesystem
// that does not enforce the mode (or a run as root) would hide the case
// instead of failing it.
const deniedRoot = mkdtempSync(join(tmpdir(), "flows-search-denied-"))
const denied = join(deniedRoot, "locked")
mkdirSync(denied, { recursive: true })
writeFileSync(join(denied, "hidden.ts"), "needle denied\n")
writeFileSync(join(deniedRoot, "listed.ts"), "needle denied\n")
chmodSync(denied, 0o000)
const modeEnforced = ((): boolean => {
  try {
    readdirSync(denied)
    return false
  } catch {
    return true
  }
})()

beforeAll(() => {
  file("src/a.ts", "intro\nNeedle one\ncontext after\nneedle two\nend")
  file("src/nested/b.ts", "needle b\nmore")
  file("src/nested/excluded.ts", "needle excluded")
  file("src/z.js", "needle javascript")
  file("src/.secret.ts", "needle secret")
  file("src/.git/objects/object.ts", "needle git")
  file("src/node_modules/pkg/index.ts", "needle dependency")
  file("src/.gitignore", "nested/b.ts\n")
  file("edge/crlf.txt", "foo\r\nbar\r\n")
  file("edge/unicode.txt", "é\n😀\n")
  file("edge/invalid-utf8.txt", new Uint8Array([110, 101, 101, 100, 108, 101, 32, 0xff, 10]))
  file("edge/binary/binary.bin", "needle before\n\0needle after\n")
  file("edge/binary/text.txt", "needle text\n")
  file("edge/long.txt", "x".repeat(600))
  file("edge/symlink-target.txt", "needle symlink target\n")
  symlinkSync(join(root, "edge/symlink-target.txt"), join(root, "edge/symlink.txt"))
  file("globs/a.ts", "")
  file("globs/nested/a.ts", "")
  file("globs/nested/deeper/dd.ts", "")
  file("globs/.hidden/h.ts", "")
  file("globs/é.ts", "")
  file("globs/😀.ts", "")
  file(
    "symbols/mod.py",
    "class Widget:\n    def widen(self, value):\n        needle = value\n        return needle\n\n\ndef other():\n    pass\n"
  )
  file("symbols/plain.txt", "needle at top level\n")
  file("budget/many.txt", "one\nneedle a\nthree\nfour\nneedle b\nsix\n")
  file("counted/one.txt", "counted needle\n")
  file("counted/two.txt", "nothing here\n")
  file("counted/three.txt", "nothing here\n")
  file("hostile/present.ts", "needle hostile\n")
  symlinkSync(join(root, "hostile/present.ts"), join(root, "hostile/alias.ts"))
  symlinkSync(join(root, "hostile/absent.ts"), join(root, "hostile/dangling.ts"))
  symlinkSync(join(root, "hostile/cycle-b"), join(root, "hostile/cycle-a"))
  symlinkSync(join(root, "hostile/cycle-a"), join(root, "hostile/cycle-b"))
})

afterAll(() => {
  chmodSync(denied, 0o755)
  rmSync(root, { recursive: true, force: true })
  rmSync(deniedRoot, { recursive: true, force: true })
})

const peers = [
  ["portable", PortableSearch.layer.pipe(Layer.provide(NodeServices.layer))],
  ["native", NativeSearch.layer.pipe(Layer.provide(NodeServices.layer))]
] as const
const portableHost = Layer.merge(NodeFileSystem.layer, Path.layer)

const scriptedNative = (options: {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly commands?: Array<ChildProcess.StandardCommand>
}) => {
  const spawner = ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        options.commands?.push(command as ChildProcess.StandardCommand)
        const stdout = Stream.make(new TextEncoder().encode(options.stdout ?? ""))
        const stderr = Stream.make(new TextEncoder().encode(options.stderr ?? ""))
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(options.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })
  return NativeSearch.layer.pipe(Layer.provide(Layer.mergeAll(
    NodeFileSystem.layer,
    Path.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)
  )))
}

const failure = <A>(exit: Exit.Exit<A, unknown>): { readonly code: unknown; readonly message: unknown } | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  if (reason === undefined || typeof reason.error !== "object" || reason.error === null) return undefined
  const record = reason.error as { readonly code?: unknown; readonly message?: unknown }
  return { code: record.code, message: record.message }
}

for (const [peer, implementation] of peers) {
  describe(`Search conformance (${peer})`, () => {
    const grep = (input: typeof Grep.Input.Type) => Effect.runPromise(Effect.provide(Grep.run(input), implementation))
    const glob = (input: typeof Glob.Input.Type) => Effect.runPromise(Effect.provide(Glob.run(input), implementation))

    it("matches with smart case, ordered include/exclude globs, context, and per-file max-count", async () => {
      const result = await grep({
        pattern: "needle",
        root: join(root, "src"),
        smartCase: true,
        globs: ["*.ts", "!excluded.ts"],
        context: 1,
        maxCount: 1
      })
      expect(result).toEqual({
        matches: [
          {
            file: join(root, "src/a.ts"),
            line: 2,
            text: "Needle one",
            before: [{ line: 1, text: "intro" }],
            after: [{ line: 3, text: "context after" }]
          },
          {
            file: join(root, "src/nested/b.ts"),
            line: 1,
            text: "needle b",
            before: [],
            after: [{ line: 2, text: "more" }]
          }
        ],
        files: [],
        filesSearched: 2,
        skippedBinary: 0,
        truncated: false
      })
    })

    it("returns sorted files for --files-with-matches and applies -i", async () => {
      const result = await grep({
        pattern: "NEEDLE",
        root: join(root, "src"),
        ignoreCase: true,
        globs: ["*.ts", "!excluded.ts"],
        filesWithMatches: true
      })
      expect(result.files).toEqual([join(root, "src/a.ts"), join(root, "src/nested/b.ts")])
      expect(result.matches).toEqual([])
    })

    it("keeps fixed strings distinct from the accepted ASCII regex dialect", async () => {
      file("edge/dialect.txt", "abc\na.c\nabbbc\n")
      const literal = await grep({ pattern: "a.c", root: join(root, "edge/dialect.txt"), fixedStrings: true })
      const regex = await grep({ pattern: "^(a.c|ab{3}c)$", root: join(root, "edge/dialect.txt") })
      expect(literal.matches.map((match) => match.line)).toEqual([2])
      expect(regex.matches.map((match) => match.line)).toEqual([1, 2, 3])
    })

    it("aligns CRLF anchors, Unicode scalars, and replacement-decoded non-UTF8 bytes", async () => {
      const crlf = await grep({ pattern: "foo$", root: join(root, "edge/crlf.txt") })
      const unicode = await grep({ pattern: "^.$", root: join(root, "edge/unicode.txt") })
      const invalidUtf8 = await grep({ pattern: "needle", root: join(root, "edge/invalid-utf8.txt") })
      expect(crlf.matches).toEqual([
        { file: join(root, "edge/crlf.txt"), line: 1, text: "foo", before: [], after: [] }
      ])
      expect(unicode.matches.map(({ line, text }) => ({ line, text }))).toEqual([
        { line: 1, text: "é" },
        { line: 2, text: "😀" }
      ])
      expect(invalidUtf8.matches).toEqual([
        { file: join(root, "edge/invalid-utf8.txt"), line: 1, text: "needle �", before: [], after: [] }
      ])
    })

    it("skips and counts NUL-bearing files and rejects an explicitly named binary root", async () => {
      const directory = await grep({ pattern: "needle", root: join(root, "edge/binary") })
      const explicit = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "absent", root: join(root, "edge/binary/binary.bin") }),
        implementation
      )))
      expect(directory).toEqual({
        matches: [
          { file: join(root, "edge/binary/text.txt"), line: 1, text: "needle text", before: [], after: [] }
        ],
        files: [],
        filesSearched: 2,
        skippedBinary: 1,
        truncated: false
      })
      expect(failure(explicit)?.code).toBe("binary_file")
    })

    it("caps very long lines and does not follow symlinks", async () => {
      const long = await grep({ pattern: "x", root: join(root, "edge/long.txt") })
      const symlink = await grep({ pattern: "needle", root: join(root, "edge"), filesWithMatches: true })
      expect(long.matches[0]?.text.length).toBeLessThanOrEqual(500)
      expect(symlink.files).toContain(join(root, "edge/symlink-target.txt"))
      expect(symlink.files).not.toContain(join(root, "edge/symlink.txt"))
    })

    it("discloses global truncation and notice semantics", async () => {
      const result = await grep({ pattern: "needle", root: join(root, "src"), globs: ["*.ts"], limit: 1 })
      expect(result).toMatchObject({ truncated: true })
      expect(result.matches).toHaveLength(1)
      expect(result.notice).toBe("Showing 1 of 3 matches; output was truncated.")
    })

    it("keeps hidden search opt-in and fixed skip roots explicit", async () => {
      const hidden = await grep({
        pattern: "needle",
        root: join(root, "src"),
        globs: ["*.ts"],
        hidden: true,
        filesWithMatches: true
      })
      const explicit = await grep({
        pattern: "needle",
        root: join(root, "src/.git"),
        globs: ["*.ts"],
        filesWithMatches: true
      })
      expect(hidden.files).toContain(join(root, "src/.secret.ts"))
      expect(hidden.files).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.files).toEqual([join(root, "src/.git/objects/object.ts")])
    })

    it("implements rg --files globs with ordering, braces, hidden, and skip rules", async () => {
      const regular = await glob({ pattern: "**/*.{ts,js}", root: join(root, "src") })
      const hidden = await glob({ pattern: "**/*.ts", root: join(root, "src"), hidden: true })
      const explicit = await glob({ pattern: "**/*.ts", root: join(root, "src/node_modules") })
      expect(regular.paths).toEqual([
        join(root, "src/a.ts"),
        join(root, "src/nested/b.ts"),
        join(root, "src/nested/excluded.ts"),
        join(root, "src/z.js")
      ])
      expect(hidden.paths).toContain(join(root, "src/.secret.ts"))
      expect(hidden.paths).not.toContain(join(root, "src/.git/objects/object.ts"))
      expect(explicit.paths).toEqual([join(root, "src/node_modules/pkg/index.ts")])
    })

    it("implements root-anchored globs and ripgrep's UTF-8 byte width for ?", async () => {
      const anchored = await glob({ pattern: "/a.ts", root: join(root, "globs") })
      const oneByte = await glob({ pattern: "?.ts", root: join(root, "globs") })
      expect(anchored.paths).toEqual([join(root, "globs/a.ts")])
      expect(oneByte.paths).toEqual([
        join(root, "globs/a.ts"),
        join(root, "globs/nested/a.ts")
      ])
    })

    it("matches relative patterns against root-relative paths", async () => {
      const nested = await glob({ pattern: "nested/*.ts", root: join(root, "globs") })
      const fromRoot = await glob({ pattern: "globs/nested/**/*.ts", root })
      const crossing = await glob({ pattern: "globs/**/dd.ts", root })
      const alternatives = await glob({ pattern: "{globs,src}/nested/*.ts", root })
      expect(nested.paths).toEqual([join(root, "globs/nested/a.ts")])
      expect(fromRoot.paths).toEqual([
        join(root, "globs/nested/a.ts"),
        join(root, "globs/nested/deeper/dd.ts")
      ])
      expect(crossing.paths).toEqual([join(root, "globs/nested/deeper/dd.ts")])
      expect(alternatives.paths).toEqual([
        join(root, "globs/nested/a.ts"),
        join(root, "src/nested/b.ts"),
        join(root, "src/nested/excluded.ts")
      ])
    })

    it("reads a leading / or ./ as the root anchor, not as a filesystem path", async () => {
      const relative = await glob({ pattern: "nested/a.ts", root: join(root, "globs") })
      const anchored = await glob({ pattern: "/nested/a.ts", root: join(root, "globs") })
      const dotted = await glob({ pattern: "./nested/a.ts", root: join(root, "globs") })
      const interior = await glob({ pattern: "nested/./a.ts", root: join(root, "globs") })
      const basename = await glob({ pattern: "a.ts", root: join(root, "globs") })
      expect(anchored.paths).toEqual(relative.paths)
      expect(dotted.paths).toEqual(relative.paths)
      expect(interior.paths).toEqual(relative.paths)
      expect(basename.paths).toEqual([join(root, "globs/a.ts"), join(root, "globs/nested/a.ts")])
    })

    it("separates a pattern that found nothing from one that could never match", async () => {
      const searched = await glob({ pattern: "globs/**/*.rs", root })
      const absolute = await glob({ pattern: `${join(root, "globs")}/**/*.ts`, root: join(root, "globs") })
      const missing = await glob({ pattern: "missing/**/*.ts", root: join(root, "globs") })
      const skipped = await glob({ pattern: "node_modules/**/*.ts", root: join(root, "src") })
      const hidden = await glob({ pattern: ".hidden/*.ts", root: join(root, "globs") })
      const included = await glob({ pattern: ".hidden/*.ts", root: join(root, "globs"), hidden: true })
      const partial = await glob({ pattern: "{missing,nested}/*.rs", root: join(root, "globs") })
      expect(searched).toEqual({ paths: [], total: 0, truncated: false })
      expect(partial).toEqual({ paths: [], total: 0, truncated: false })
      expect(absolute.notice).toBe(
        `No file under ${join(root, "globs")} can match "${
          join(root, "globs")
        }/**/*.ts": glob patterns are relative to the search root, so use "**/*.ts" instead.`
      )
      expect(missing.notice).toBe(
        `No file under ${join(root, "globs")} can match "missing/**/*.ts": there is no missing directory there.`
      )
      expect(skipped.notice).toBe(
        `No file under ${join(root, "src")} can match "node_modules/**/*.ts": node_modules is never descended into; ` +
          "name it as the search root to look inside it."
      )
      expect(hidden.notice).toBe(
        `No file under ${
          join(root, "globs")
        } can match ".hidden/*.ts": hidden paths are excluded unless hidden is true.`
      )
      expect(included.paths).toEqual([join(root, "globs/.hidden/h.ts")])
    })

    it("reads grep globs by the same rules and reports the unsatisfiable ones", async () => {
      const nested = await grep({
        pattern: "needle",
        root,
        globs: ["src/nested/*.ts", "!**/excluded.ts"],
        filesWithMatches: true
      })
      const searched = await grep({ pattern: "definitely absent", root: join(root, "src"), globs: ["*.ts"] })
      const absolute = await grep({ pattern: "needle", root: join(root, "src"), globs: [`${join(root, "src")}/*.ts`] })
      const exclusionOnly = await grep({ pattern: "definitely absent", root: join(root, "src"), globs: ["!missing/*"] })
      const several = await grep({ pattern: "needle", root: join(root, "src"), globs: ["missing/*.ts", "gone/*.ts"] })
      expect(nested.files).toEqual([join(root, "src/nested/b.ts")])
      expect(several.notice).toBe(
        `No file under ${join(root, "src")} can match "missing/*.ts": there is no missing directory there. ` +
          `No file under ${join(root, "src")} can match "gone/*.ts": there is no gone directory there.`
      )
      expect(searched.notice).toBeUndefined()
      expect(absolute).toMatchObject({ matches: [], files: [] })
      expect(absolute.notice).toBe(
        `No file under ${join(root, "src")} can match "${
          join(root, "src")
        }/*.ts": glob patterns are relative to the search root, so use "*.ts" instead.`
      )
      expect(exclusionOnly.notice).toBeUndefined()
    })

    it("searches a root that names one file whatever the globs say", async () => {
      const matching = await grep({
        pattern: "needle",
        root: join(root, "src/a.ts"),
        globs: ["*.ts"],
        filesWithMatches: true
      })
      const mismatching = await grep({
        pattern: "needle",
        root: join(root, "src/a.ts"),
        globs: ["missing/*.js"],
        filesWithMatches: true
      })
      const empty = await grep({ pattern: "definitely absent", root: join(root, "src/a.ts"), globs: ["missing/*.js"] })
      const listed = await glob({ pattern: "*.js", root: join(root, "src/a.ts") })
      const linked = await grep({ pattern: "hostile", root: join(root, "hostile/alias.ts"), filesWithMatches: true })
      expect(matching.files).toEqual([join(root, "src/a.ts")])
      expect(mismatching.files).toEqual([join(root, "src/a.ts")])
      expect(mismatching.notice).toBeUndefined()
      expect(empty).toEqual({ matches: [], files: [], filesSearched: 1, skippedBinary: 0, truncated: false })
      expect(listed.paths).toEqual([join(root, "src/a.ts")])
      expect(linked.files).toEqual([join(root, "hostile/alias.ts")])
    })

    it("counts every file the search covered, not only the files that matched", async () => {
      const found = await grep({ pattern: "counted needle", root: join(root, "counted") })
      const absent = await grep({ pattern: "definitely absent", root: join(root, "counted") })
      expect(found).toMatchObject({ filesSearched: 3, skippedBinary: 0, matches: [{ line: 1 }] })
      expect(absent).toMatchObject({ filesSearched: 3, matches: [], truncated: false })
    })

    it("walks past dangling links and link cycles instead of failing the search", async () => {
      const paths = await glob({ pattern: "*.ts", root: join(root, "hostile") })
      const matches = await grep({ pattern: "hostile", root: join(root, "hostile"), filesWithMatches: true })
      expect(paths.paths).toEqual([join(root, "hostile/present.ts")])
      expect(matches).toMatchObject({ files: [join(root, "hostile/present.ts")], filesSearched: 1 })
    })

    it.skipIf(!modeEnforced)("walks past a directory it may not list", async () => {
      const paths = await glob({ pattern: "**/*.ts", root: deniedRoot })
      const matches = await grep({ pattern: "denied", root: deniedRoot, filesWithMatches: true })
      expect(paths.paths).toEqual([join(deniedRoot, "listed.ts")])
      expect(matches).toMatchObject({ files: [join(deniedRoot, "listed.ts")], filesSearched: 1 })
    })

    it("drops a glob's trailing spaces as rg does and rejects what that leaves blank", async () => {
      const padded = await glob({ pattern: "a.ts ", root: join(root, "globs") })
      const anchored = await glob({ pattern: "/nested/a.ts  ", root: join(root, "globs") })
      const blank = await Effect.runPromise(Effect.exit(Effect.provide(
        Glob.run({ pattern: "  ", root }),
        implementation
      )))
      const noMatchWanted = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root: join(root, "src"), maxCount: 0 }),
        implementation
      )))
      expect(padded.paths).toEqual([join(root, "globs/a.ts"), join(root, "globs/nested/a.ts")])
      expect(anchored.paths).toEqual([join(root, "globs/nested/a.ts")])
      expect(failure(blank)).toEqual({
        code: "invalid_pattern",
        message: "Unsupported ripgrep pattern \"  \": glob patterns must not be empty"
      })
      expect(failure(noMatchWanted)).toEqual({
        code: "invalid_input",
        message: "Invalid ripgrep options: --max-count must be at least 1"
      })
    })

    it("spends the limit on matches and never drops a hit to fit its context", async () => {
      const clipped = await grep({ pattern: "needle", root: join(root, "budget"), context: 2, limit: 1 })
      const whole = await grep({ pattern: "needle", root: join(root, "budget"), context: 2 })
      expect(clipped.matches).toEqual([{
        file: join(root, "budget/many.txt"),
        line: 2,
        text: "needle a",
        before: [{ line: 1, text: "one" }],
        after: [{ line: 3, text: "three" }]
      }])
      expect(clipped.truncated).toBe(true)
      expect(clipped.notice).toBe("Showing 1 of 2 matches; output was truncated.")
      expect(whole.matches.map((match) => match.line)).toEqual([2, 5])
      // Every context line the search selected belongs to exactly one hit.
      expect(whole.matches.flatMap((match) => [...match.before, ...match.after].map((line) => line.line)))
        .toEqual([1, 3, 4, 6])
    })

    it("reports the definition a hit sits in, and omits it on request", async () => {
      const python = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.py"] })
      const topLevel = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.txt"] })
      const without = await grep({ pattern: "needle", root: join(root, "symbols"), globs: ["*.py"], symbols: false })
      expect(python.matches[0]?.symbol).toEqual({ kind: "def", name: "widen", startLine: 2, endLine: 4 })
      expect(topLevel.matches[0]?.symbol).toBeUndefined()
      expect(without.matches[0]?.symbol).toBeUndefined()
    })

    it("retries a metacharacter pattern as a literal and flags that it did", async () => {
      const retried = await grep({ pattern: "widen(self, value)", root: join(root, "symbols"), globs: ["*.py"] })
      const absent = await grep({ pattern: "absent(x)", root: join(root, "symbols") })
      expect(retried.matches.map((match) => match.line)).toEqual([2])
      expect(retried.retriedAsLiteral).toBe(true)
      expect(retried.notice).toContain("fixedStrings: true")
      expect(absent.matches).toEqual([])
      expect(absent.retriedAsLiteral).toBeUndefined()
    })

    it("returns clean empty results and a typed missing-root failure", async () => {
      const empty = await grep({ pattern: "definitely absent", root: join(root, "src") })
      const missing = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root: join(root, "missing") }),
        implementation
      )))
      expect(empty).toMatchObject({ matches: [], files: [], truncated: false })
      expect(failure(missing)?.code).toBe("not_found")
    })

    it("rejects every option outside the declared subset with typed errors", async () => {
      const unsupported = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "(?=needle)", root }),
        implementation
      )))
      const ignoreFiles = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "needle", root, noIgnore: false }),
        implementation
      )))
      const emptyExclusion = await Effect.runPromise(Effect.exit(Effect.provide(
        Glob.run({ pattern: "!", root }),
        implementation
      )))
      const oversizedRepetition = await Effect.runPromise(Effect.exit(Effect.provide(
        Grep.run({ pattern: "a{10000000}", root }),
        implementation
      )))
      expect(failure(unsupported)).toEqual({
        code: "invalid_pattern",
        message: "Unsupported ripgrep pattern \"(?=needle)\": special groups and lookaround are not supported"
      })
      expect(failure(ignoreFiles)?.code).toBe("invalid_input")
      expect(failure(emptyExclusion)?.code).toBe("invalid_pattern")
      expect(failure(oversizedRepetition)?.code).toBe("invalid_pattern")
    })
  })
}

it("the in-process peer answers without an rg process service", async () => {
  const result = await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "needle", root: join(root, "src"), fixedStrings: true, globs: ["*.ts"] }),
    PortableSearch.layer.pipe(Layer.provide(portableHost))
  ))
  expect(result.matches.length).toBeGreaterThan(0)
})

it("both peers reject unsupported regex syntax identically", async () => {
  const exits = await Promise.all(
    peers.map(([, implementation]) =>
      Effect.runPromise(Effect.exit(Effect.provide(Grep.run({ pattern: "(a)\\1", root }), implementation)))
    )
  )
  const portable = exits[0]
  const native = exits[1]
  expect(portable).toBeDefined()
  expect(native).toBeDefined()
  if (portable === undefined || native === undefined) return
  expect(failure(portable)).toEqual(failure(native))
})

it("the native peer turns absence, non-zero exits, and malformed JSON into typed failures", async () => {
  const unavailable = NativeSearch.layer.pipe(Layer.provide(Layer.mergeAll(
    NodeFileSystem.layer,
    Path.layer,
    ChildProcessSpawner.layerNoop()
  )))
  const cases = [
    [unavailable, "provider_unavailable"],
    [scriptedNative({ stderr: "killed", exitCode: 137 }), "request_failed"],
    [scriptedNative({ stdout: "{}\n" }), "request_failed"]
  ] as const
  for (const [implementation, code] of cases) {
    const exit = await Effect.runPromise(Effect.exit(Effect.provide(
      Grep.run({ pattern: "needle", root: join(root, "src") }),
      implementation
    )))
    expect(failure(exit)?.code).toBe(code)
  }
})

it("the native peer launches only cwd-rooted rg processes through the injected process layer", async () => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const summary = JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })
  await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "absent", root: join(root, "src") }),
    scriptedNative({ stdout: `${summary}\n`, commands })
  ))
  expect(commands).toHaveLength(3)
  expect(commands.every((command) => command.command === "rg")).toBe(true)
  expect(commands.every((command) => command.options.cwd === join(root, "src"))).toBe(true)
})

it("the native peer keeps what rg produced when it only skipped what it could not read", async () => {
  const summary = JSON.stringify({ type: "summary", data: { stats: { searches: 0 } } })
  const tolerated = await Effect.runPromise(Effect.provide(
    Grep.run({ pattern: "absent", root: join(root, "src") }),
    scriptedNative({ stdout: `${summary}\n`, exitCode: 2 })
  ))
  const listed = await Effect.runPromise(Effect.provide(
    Glob.run({ pattern: "*.ts", root: join(root, "src") }),
    scriptedNative({ stdout: "a.ts\n", exitCode: 2 })
  ))
  const rejected = await Effect.runPromise(Effect.exit(Effect.provide(
    Glob.run({ pattern: "*.ts", root: join(root, "src") }),
    scriptedNative({ stderr: "rg: error parsing glob", exitCode: 2 })
  )))
  expect(tolerated).toMatchObject({ matches: [], files: [] })
  expect(listed.paths).toEqual([join(root, "src/a.ts")])
  expect(failure(rejected)).toEqual({ code: "invalid_pattern", message: "rg: error parsing glob" })
})
