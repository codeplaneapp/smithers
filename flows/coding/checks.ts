/** Revision checks are ordinary actions over Plue's read-only JJ tree export. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Check, CodingError, Implementation, Receipt, checkInputDigest } from "./schema.ts"

/** The registered Markdown flow's verified body, never an agent's check result. */
const Command = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3_600_000))
})
const Input = Schema.Struct({ implementation: Implementation, check: Check })
const ExportedTree = Schema.Struct({
  commitId: Schema.String, changeId: Schema.String, treeId: Schema.String,
  path: Schema.String, fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export const CheckCommand = Action.make("coding/check-command", {
  // Invocation includes the pinned body, so command changes change action keys.
  payload: Executable.Invocation, success: Receipt, error: CodingError, nondeterministic: true
})
export const checkDelegate = Flow.make("coding/CommandCheck", {
  payload: Executable.Invocation, success: Receipt, error: CodingError,
  body: invocation => CheckCommand.call(invocation)
})

export interface CheckHostOptions {
  readonly repositoryPath: string
  /** Existing trusted host filesystem, captured before action workspace guards. */
  readonly fs: FileSystem.FileSystem
  readonly exporterPath?: string | undefined
  /** Host-selected build environment. No operator/provider credentials by default. */
  readonly environment?: Readonly<Record<string, string>> | undefined
}

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const outputLimit = 128 * 1024
/** Drain every byte, retaining only a bounded prefix for the existing receipt. */
const capture = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(stream, () => ({ text: "", bytes: 0, kept: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const selected = chunk.subarray(0, Math.max(0, outputLimit - state.kept))
    return {
      text: state.text + state.decoder.decode(selected, { stream: true }),
      bytes: state.bytes + chunk.length, kept: state.kept + selected.length, decoder: state.decoder
    }
  }).pipe(Effect.map(state => ({ text: state.text + state.decoder.decode(), truncated: state.bytes > outputLimit })))

/** Supply this layer to the existing native action table and register checkDelegate. */
export const checkLayers = (options: CheckHostOptions) => Layer.mergeAll(
  Interpreter.layer(checkDelegate),
  CheckCommand.toLayer(invocation => Effect.gen(function*() {
    const { implementation, check } = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
      .pipe(Effect.mapError(() => invalid("Check input must identify the implemented revision and declared check")))
    if (invocation.flow !== check.flow) return yield* invalid("The registered check flow does not match the plan")
    // MarkdownFlow appends resource context and encoded arguments after the
    // verified body. This recipe's declaration is the first nonempty JSON line.
    const command = yield* Effect.try({ try: () => JSON.parse(invocation.prompt.trimStart().split(/\r?\n/, 1)[0] ?? "") as unknown,
      catch: () => invalid("The registered check body must be a JSON command declaration") }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Command)),
      Effect.mapError(() => invalid("The registered check body needs argv, relative cwd and a bounded timeoutMs"))
    )
    if (!/^[0-9a-f]{40}$/.test(implementation.head.commitId) || !/^[0-9a-f]{40}$/.test(implementation.head.treeId)) {
      return yield* invalid("Checks require full immutable native commit and tree IDs")
    }
    // Scratch export/cleanup is host bookkeeping. The host explicitly supplies
    // its filesystem; agent tools keep their ordinary guarded filesystem.
    const fs = options.fs
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    if (!path.isAbsolute(command.argv[0]) && options.environment?.PATH === undefined) {
      return yield* invalid("A relative check executable requires a host-supplied PATH; otherwise use an absolute executable")
    }
    if (path.isAbsolute(command.cwd) || command.cwd.split(/[\\/]/).includes("..")) {
      return yield* invalid("Check cwd must remain inside the exported source tree")
    }
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-check-" })
    const temporaryRoot = yield* fs.realPath(temporary)
    const contained = (root: string, candidate: string) => {
      const relative = path.relative(root, candidate)
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    }
    const execute = (argv: ReadonlyArray<string>, cwd: string, timeoutMs: number) => Effect.gen(function*() {
      const process = yield* spawner.spawn(ChildProcess.make(argv[0]!, argv.slice(1), {
        cwd, env: options.environment ?? {}, extendEnv: false, stdin: "ignore"
      }))
      const [stdout, stderr, exitCode] = yield* Effect.all([
        capture(process.stdout), capture(process.stderr), process.exitCode
      ], { concurrency: "unbounded" })
      return { stdout, stderr, exitCode }
    }).pipe(Effect.scoped, Effect.timeoutOrElse({ duration: timeoutMs,
      orElse: () => Effect.fail(new CodingError({ code: "execution", message: "Revision check process exceeded its declared timeout" })) }))
    const exported = yield* execute([
      options.exporterPath ?? "/usr/local/bin/smithers-jj-export",
      options.repositoryPath, implementation.head.commitId, temporaryRoot
    ], options.repositoryPath, 60_000)
    if (exported.exitCode !== 0 || exported.stdout.truncated) return yield* invalid("Native immutable tree export failed; no check receipt was accepted")
    const tree = yield* Effect.try({ try: () => JSON.parse(exported.stdout.text) as unknown,
      catch: () => invalid("Native tree exporter returned no valid identity") }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExportedTree)),
      Effect.mapError(() => invalid("Native tree exporter returned no valid identity"))
    )
    if (tree.commitId !== implementation.head.commitId || tree.treeId !== implementation.head.treeId || tree.changeId !== implementation.head.changeId) {
      return yield* invalid("Native exported tree does not match the planned revision")
    }
    const root = yield* fs.realPath(tree.path)
    if (root === temporaryRoot || !contained(temporaryRoot, root)) return yield* invalid("Native exporter returned a path outside its private temporary directory")
    // A committed symlink into the editing checkout would make old source read
    // live bytes. Inspect links before any check starts; internal aliases are
    // allowed and canonical directories are visited only once.
    const pending = [root], visited = new Set<string>()
    while (pending.length) {
      const directory = pending.pop()!
      if (visited.has(directory)) continue
      visited.add(directory)
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = yield* fs.realPath(path.join(directory, name)).pipe(
          Effect.mapError(() => invalid("Exported source contains an unresolved symbolic link or missing entry")))
        if (!contained(root, entry)) return yield* invalid("Exported source contains a symbolic link outside its immutable tree")
        if ((yield* fs.stat(entry)).type === "Directory") pending.push(entry)
      }
    }
    const cwd = yield* fs.realPath(path.resolve(root, command.cwd))
    if (!contained(root, cwd)) return yield* invalid("Check cwd resolves outside its immutable source export")
    const result = yield* execute(command.argv, cwd, command.timeoutMs)
    const passed = result.exitCode === 0
    return {
      checkId: check.id, target: check.target, tier: check.tier, change: implementation.change,
      commitId: tree.commitId, treeId: tree.treeId, inputDigest: checkInputDigest(implementation, check),
      status: passed ? "passed" as const : "failed" as const,
      evidence: JSON.stringify({ argv: command.argv, cwd: command.cwd, exitCode: result.exitCode,
        stdout: result.stdout.text, stderr: result.stderr.text,
        truncated: result.stdout.truncated || result.stderr.truncated, fileCount: tree.fileCount }),
      findings: passed ? [] : [{ owner: implementation.change, sourceCommitId: tree.commitId,
        message: `${check.target} exited with code ${result.exitCode}` }]
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError(error => error instanceof CodingError ? error : new CodingError({
      code: "execution", message: "Revision check could not execute or finish its temporary source cleanup" +
        (error instanceof Error ? `: ${error.message.slice(0, 2_048)}` : "")
    }))
  ))
)
