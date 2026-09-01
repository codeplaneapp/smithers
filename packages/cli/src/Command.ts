/**
 * The `smithers` command tree.
 *
 * Every verb in rc-contract section 4.1 is here with a handler, and every verb
 * and flag in section 4.2 is here as a hidden refusal. Those two facts are the
 * whole design: a release that silently accepts a removed verb, or that
 * answers a removed one with a parser error, leaves an operator guessing which
 * of their scripts still mean what they used to.
 *
 * Handlers talk to `Control` and nothing else. A command that reached into a
 * store would answer differently under `--remote`, and the point of the
 * control plane is that it does not.
 *
 * @since 1.0.0
 */
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import * as UnsupportedBackend from "@smthrs/database/UnsupportedBackend"
import * as ResolveJj from "@smthrs/jj/node/resolveJjBinary"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import type * as Namespace from "@smthrs/memory/Namespace"
import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import { Console, Effect, Option, Schema, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as Agents from "./Agents.ts"
import * as Bug from "./Bug.ts"
import * as ClaudeMirror from "./ClaudeMirror.ts"
import * as CliError from "./CliError.ts"
import * as Detached from "./Detached.ts"
import * as Docs from "./Docs.ts"
import * as Doctor from "./Doctor.ts"
import * as Environment from "./Environment.ts"
import * as ExecutorOwnership from "./ExecutorOwnership.ts"
import * as Forensics from "./Forensics.ts"
import * as Gc from "./Gc.ts"
import * as Init from "./Init.ts"
import * as Legacy from "./Legacy.ts"
import * as NodeOutput from "./NodeOutput.ts"
import { Output } from "./Output.ts"
import * as Project from "./Project.ts"
import * as Serve from "./Serve.ts"
import * as Unsupported from "./Unsupported.ts"
import * as Update from "./Update.ts"
import * as Verb from "./Verb.ts"
import { packageVersion } from "./Version.ts"

const global = {
  credential: Flag.string("credential").pipe(Flag.optional),
  json: Flag.boolean("json"),
  remote: Flag.string("remote").pipe(Flag.optional),
  quiet: Flag.boolean("quiet"),
  // Declared here so the CLI's own flag validation accepts them; the values
  // are read from raw argv by `NodeControl.makeConfig`, which runs before the
  // durable layers are built.
  mcpConfig: Flag.string("mcp-config").pipe(Flag.optional),
  root: Flag.string("root").pipe(Flag.optional),
  // Hidden, and the one removed flag with a supported value: `sqlite` names
  // the backend rc.0 has, so it is a no-op rather than a refusal.
  backend: Flag.string("backend").pipe(Flag.optional, Flag.withHidden)
}

const rootCommand = Command.make("smithers").pipe(Command.withSharedFlags(global))

const input = Argument.string("key=value").pipe(Argument.variadic())
const data = Flag.string("data").pipe(Flag.optional)
const common = { input, data }

/**
 * Removed verbs that are registered by hand instead of by the loop below,
 * because their bare form still does something: `gateway` runs `serve` and
 * `workflow list` is the `ls` alias.
 */
const ownGroupCommands = new Set(["gateway", "workflow"])

/** One removed verb by name, so a handler cannot cite the wrong entry. */
const removedVerb = (name: string): Unsupported.RemovedVerb =>
  Unsupported.removedVerbs.find((verb) => verb.name === name)!

/** A hidden boolean flag whose presence is a refusal. */
const removedFlag = (parent: string, name: string) => Flag.boolean(name).pipe(Flag.withHidden)

/** A hidden value flag whose presence is a refusal. */
const removedValueFlag = (name: string) => Flag.string(name).pipe(Flag.optional, Flag.withHidden)

/**
 * Fails when a removed flag was passed.
 *
 * Taking the whole flag record and the names to check keeps the refusal in one
 * place: a handler that forgot one would accept a flag the contract removed.
 */
const refuseRemoved = (
  parent: string,
  passed: Readonly<Record<string, boolean | Option.Option<string>>>
): Effect.Effect<void, CliError.UnsupportedError> => {
  for (const [name, value] of Object.entries(passed)) {
    const present = typeof value === "boolean" ? value : Option.isSome(value)
    if (present) return Effect.fail(Unsupported.flagError(Unsupported.findFlag(parent, name)))
  }
  return Effect.void
}

/**
 * The shared pre-handler: the globals every handler is checked against, and
 * the one notice every handler owes.
 *
 * Section 6's detection is "when a command runs in a directory", so it belongs
 * here rather than in a verb. Wired into `ls` and `up` alone it printed only
 * when one of those two happened to be the first command an operator typed in
 * a 0.x project, because the first invocation writes `.flows/` and the sample
 * treats that as proof the project has moved on.
 */
const guardGlobals = Effect.gen(function*() {
  const root = yield* rootCommand
  // A 0.x PostgreSQL or PGlite project still exports its connection strings.
  // rc.0 ignores them and says so, once per invocation, because a silently
  // ignored connection string is how a project ends up running against SQLite
  // while believing it runs against PostgreSQL. A notice, not a refusal: the
  // exit code and the command's result do not move (rc-contract section 2; the
  // names and the sentence are @smthrs/database's, pinned per name in
  // packages/database/test/UnsupportedBackend.test.ts).
  for (const name of UnsupportedBackend.ignoredNames(process.env)) {
    process.stderr.write(`${UnsupportedBackend.ignoredNotice(name)}\n`)
  }
  const backend = Option.getOrUndefined(root.backend)
  const refusal = Environment.unsupportedBackend(backend)
  if (refusal !== undefined) return yield* Effect.fail(new CliError.UnsupportedError({ message: refusal }))
  // `SMITHERS_BACKEND` reaches the same refusal: a script that exports the
  // variable must not be told everything is fine because it omitted the flag.
  const fromEnvironment = Environment.unsupportedBackend(Environment.read(process.env, "SMITHERS_BACKEND"))
  if (fromEnvironment !== undefined) {
    return yield* Effect.fail(new CliError.UnsupportedError({ message: fromEnvironment }))
  }
  yield* noticeLegacyState
})

const malformedJson = (label: string): CliError.UsageError =>
  new CliError.UsageError({ message: `${label} must be valid JSON` })

const schemaMismatch = (label: string): CliError.UsageError =>
  new CliError.UsageError({ message: `${label} must match the expected payload schema` })

const decodeJson = <A>(
  label: string,
  serialized: string,
  decode: (value: unknown) => A
): Effect.Effect<A, CliError.UsageError> =>
  Effect.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: () => malformedJson(label)
  }).pipe(
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => decode(decoded),
        catch: () => schemaMismatch(label)
      })
    )
  )

const decodeInput = (
  entries: ReadonlyArray<string>,
  raw: Option.Option<string>
): Effect.Effect<unknown, CliError.UsageError> => {
  const pairs = Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=")
    return separator < 1 ? [entry, true] : [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  if (Option.isNone(raw)) return Effect.succeed(pairs)
  return decodeJson(
    "--data",
    raw.value,
    (decoded) =>
      decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { ...pairs, ...(decoded as Record<string, unknown>) }
        : { ...pairs, data: decoded }
  )
}

const approval = (serialized: string): Effect.Effect<ControlService.ApprovalInput, CliError.UsageError> =>
  decodeJson("approval", serialized, Schema.decodeUnknownSync(ControlSchema.ApprovalPayload))

const signal = (serialized: string): Effect.Effect<ControlSchema.SignalPayload, CliError.UsageError> =>
  decodeJson("signal-json", serialized, Schema.decodeUnknownSync(ControlSchema.SignalPayload))

const render = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* rootCommand
    const rendered = yield* output.render(value, root.json ? "json" : "human")
    if (!root.quiet) yield* Console.log(rendered.text)
  })

/** Forces JSON rendering, for the `events` alias and the `--json` contract. */
const renderJson = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* rootCommand
    const rendered = yield* output.render(value, "json")
    if (!root.quiet) yield* Console.log(rendered.text)
  })

/**
 * A local CLI owns the executor layer. Keep that scope alive after accepting
 * a run so its driver is not interrupted as soon as the receipt is printed.
 * A settlement is any event that leaves this process nothing to drive: a park
 * for approval, a `pending` launch the executor declined, or a terminal
 * status.
 */
const settled = (kind: string): boolean =>
  kind === "control.run.waiting-approval" ||
  kind === "control.run.pending" ||
  kind === "control.run.completed" ||
  kind === "control.run.failed" ||
  kind === "control.run.cancelled"

const recoverWatch = <A>(
  error: unknown,
  runId: string,
  message: string,
  fallback: A
): Effect.Effect<A> => Console.error(`${message} (${runId})`, error).pipe(Effect.as(fallback))

/**
 * Waits for the run to settle and reports the event kind that settled it, or
 * `undefined` when nothing was waited for.
 */
const awaitRun = (
  control: ControlService.Service,
  runId: string,
  afterSequence: number | undefined
): Effect.Effect<string | undefined, never> =>
  control.watch(afterSequence === undefined ? { runId } : { runId, afterSequence }).pipe(
    Stream.filter((event) => settled(event.kind)),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events) => globalThis.Array.from(events)[0]?.kind),
    // A transport failure still lets the process close normally; remote CLI
    // ownership belongs to the server, and the receipt was already durable.
    Effect.catch((error) =>
      recoverWatch(error, runId, "The control watch failed while waiting for the run to settle", undefined)
    )
  )

/**
 * The sequence of the latest committed `control.run.waiting-approval` event:
 * the park a resume applies to. It keys the resume mutation, so resuming a
 * second park is a fresh mutation instead of a replay of the first resume's
 * recorded receipt, and it scopes the settlement wait.
 */
const latestPark = (
  control: ControlService.Service,
  runId: string
): Effect.Effect<number | undefined, never> =>
  control.watch({ runId, follow: false }).pipe(
    Stream.filter((event) => event.kind === "control.run.waiting-approval"),
    Stream.runCollect,
    Effect.map((events) => events.length === 0 ? undefined : Math.max(...events.map((event) => event.sequence))),
    Effect.catch((error) =>
      recoverWatch(error, runId, "The control watch failed while finding the run's latest approval park", undefined)
    )
  )

const awaitOwnedRun = (
  control: ControlService.Service,
  receipt: ControlSchema.Receipt,
  afterSequence: number | undefined
): Effect.Effect<string | undefined, never> =>
  Effect.gen(function*() {
    // A run that had already settled when the verb reached it has no
    // settlement event left to wait for, and the receipt carries the answer.
    // Without this, `smithers run --resume <run-id>` against a run that
    // settled `failed` printed `{"_tag":"Terminal","status":"failed"}` and
    // exited 0, because every receipt tag but `Accepted` reported nothing at
    // all (recorded by the cli-exit-code lane's verifier).
    if (receipt._tag === "Terminal") return `control.run.${receipt.status}`
    const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
    if (!ownsExecutor || receipt._tag !== "Accepted" || receipt.runId === undefined) return undefined
    return yield* awaitRun(control, receipt.runId, afterSequence)
  })

/**
 * The park a decision answers, or nothing for a plan-level decision.
 *
 * `Control.approve` and `Control.deny` restart the run their `ask` parked, in
 * the deciding call (rc-contract section 5.1). The driver that picks that
 * resume up is this process's own executor, so a command that printed its
 * receipt and returned took the driver down with it and left the run it had
 * just restarted exactly where it stood — still needing `run --resume`, which
 * is the second call the contract says a decision replaces.
 *
 * A plan-level decision has no run yet, and the settlement wait needs one.
 */
const decisionPark = (
  control: ControlService.Service,
  target: ControlSchema.ApprovalTarget
): Effect.Effect<number | undefined, never> =>
  target._tag === "Node" ? latestPark(control, target.runId) : Effect.succeed(undefined)

/**
 * Renders what the control plane knows about a declined launch, and returns
 * the refusal the verb exits with.
 *
 * `control.run.pending` is the executor saying it will not take the run: no
 * seat resolved, a capability was not granted, or the host refused it. The run
 * row is durable and stays at `accepted` with nothing driving it. Printing the
 * launch receipt there said `Accepted` and exited 0, which is the one answer
 * that is wrong in both halves.
 */
const declinedLaunch = (control: ControlService.Service, runId: string) =>
  Effect.gen(function*() {
    const summary = yield* summaryOf(control, runId)
    if (summary !== undefined) yield* render(summary)
    return new CliError.UnsupportedError({
      message: `Run ${runId} was accepted but the executor did not take it: it is ` +
        `${summary?.status ?? "accepted"} with nothing running. This host resolved no seat for the flow, or ` +
        `refused the launch. Read \`smithers status ${runId}\` and \`smithers ps\`, then run ` +
        `\`smithers doctor\` to see which provider keys this project has.`
    })
  })

/** Whether the settlement this process waited for was the executor declining. */
const wasDeclined = (settlement: string | undefined): boolean => settlement === "control.run.pending"

/**
 * The process status one settlement reports, or nothing when the settlement
 * says nothing about how the run ended.
 *
 * rc-contract section 4's `up` row and section 10 both promise that an
 * attached launch exits with the terminal status code. Section 4's opening
 * paragraph is the vocabulary that code is spelled in: 0 success, 1 error, 2
 * usage, 3 parked, 130 SIGINT, 143 SIGTERM. A cancel reports the interrupt
 * status because a cancel is an interruption: `Control.cancel` settles the run
 * through `ControlRuntime.interrupt`, and reporting it separately keeps a
 * cancelled run distinguishable from a failed one.
 *
 * Until this existed, `runLaunch` failed only on `control.run.pending`, so a
 * `control.run.failed` settlement rendered the launch receipt and exited 0.
 * No caller of `smithers up` could read a red run from the exit code: the
 * Phase 7 Plue cutover measured `smithers up ci-fast --json` returning 0 in
 * three seconds while `smithers ps` reported `failed` (finding S1).
 */
const settlementStatus = (settlement: string | undefined): number | undefined => {
  switch (settlement) {
    case "control.run.completed":
      return 0
    case "control.run.failed":
      return 1
    case "control.run.cancelled":
      return 130
    case "control.run.waiting-approval":
      return 3
    default:
      return undefined
  }
}

/**
 * Reports a settled run's terminal status as this process's exit status.
 *
 * Written after the receipt is rendered, never instead of it: the `--json`
 * contract is that an attached launch prints its receipt, and a caller reads
 * `runId` from that document whatever the run then did. `bin.ts` hands a
 * successful exit whatever `process.exitCode` holds, which is how
 * `smithers migrate` reports its own status too.
 */
const reportSettlement = (settlement: string | undefined) =>
  Effect.sync(() => {
    const status = settlementStatus(settlement)
    if (status !== undefined) process.exitCode = status
  })

/** Every event of one run, oldest first. */
const eventsOf = (control: ControlService.Service, runId: string) =>
  Stream.runCollect(control.watch({ runId, follow: false })).pipe(
    Effect.map((events) => globalThis.Array.from(events)),
    Effect.catch((error) =>
      recoverWatch(
        error,
        runId,
        "The control watch failed while reading the run's event history",
        [] as ReadonlyArray<ControlSchema.ControlEvent>
      )
    )
  )

/** One run's summary, or undefined when the control plane has no such run. */
const summaryOf = (control: ControlService.Service, runId: string) =>
  Effect.map(
    control.list({ _tag: "runs", filters: { runId } }),
    (listed) => listed._tag === "runs" ? listed.items.find((item) => item.runId === runId) : undefined
  )

/** A digest of one 0.x notice, printed once per invocation. */
const noticeLegacyState = Effect.gen(function*() {
  // The snapshot, not a fresh walk: this invocation's own control database
  // has created `<root>/.flows` by now, and `Project.legacyState` reads that
  // directory as proof the project already moved on (rc-contract section 6).
  const found = yield* Project.LegacyState
  const first = found[0]
  if (first === undefined) return
  yield* Effect.sync(() => process.stderr.write(`${Project.legacyNotice(first)}\n`))
})

// == section 4.1 verbs

const plan = Command.make("plan", common, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const decodedInput = yield* decodeInput(config.input.slice(1), config.data)
    const flowId = config.input[0] ?? ""
    if (Unsupported.isReservedFlow(flowId)) {
      return yield* Effect.fail(Unsupported.reservedFlowError("plan", flowId))
    }
    const control = yield* ControlService.Control
    yield* render(yield* control.plan({ flowId, input: decodedInput }))
  })).pipe(Command.withDescription(Verb.find("plan")!.help))

const runResume = (planOrRunId: string) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const parkSequence = yield* latestPark(control, planOrRunId)
    const receipt = yield* control.resume({
      runId: planOrRunId,
      idempotencyKey: parkSequence === undefined
        ? `cli:resume:${planOrRunId}`
        : `cli:resume:${planOrRunId}:${parkSequence}`
    })
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    if (wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* render(receipt)
    return yield* reportSettlement(settlement)
  })

/**
 * Announces a detached run's admission to its own log, as soon as the run row
 * is durable. The launcher in the parent process waits for exactly this line.
 */
const announceAdmission = (receipt: ControlSchema.Receipt) =>
  Effect.sync(() => {
    const nonce = process.env[Detached.admissionVariable]
    if (nonce === undefined || nonce === "") return
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return
    process.stderr.write(`${Detached.admissionLine(nonce, receipt.runId)}\n`)
  })

const runLaunch = (payload: ControlService.ApprovalInput) =>
  Effect.gen(function*() {
    const target = payload.target
    if (target._tag !== "Plan") {
      return yield* Effect.fail(new CliError.UsageError({ message: "run requires a plan approval payload" }))
    }
    const control = yield* ControlService.Control
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: target.planId,
      digest: target.digest,
      envelope: target.envelope,
      idempotencyKey: payload.idempotencyKey
    })
    yield* announceAdmission(receipt)
    const settlement = yield* awaitOwnedRun(control, receipt, undefined)
    if (wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* render(receipt)
    yield* reportSettlement(settlement)
  })

const run = Command.make("run", {
  plan: Argument.string("plan-payload"),
  resume: Flag.boolean("resume")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    if (config.resume) return yield* runResume(config.plan)
    yield* runLaunch(yield* approval(config.plan))
  })).pipe(Command.withDescription(Verb.find("run")!.help))

const resume = Command.make("resume", { runId: Argument.string("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* runResume(config.runId)
  })).pipe(Command.withDescription("Alias of `run --resume`"), Command.unlisted)

const upFlags = {
  flow: Argument.string("flow"),
  data,
  detached: Flag.boolean("detached").pipe(Flag.withAlias("d")),
  serve: removedFlag("up", "serve"),
  interactive: removedFlag("up", "interactive"),
  supervise: removedFlag("up", "supervise"),
  herdr: removedFlag("up", "herdr"),
  monitor: removedFlag("up", "monitor"),
  report: removedFlag("up", "report"),
  force: removedFlag("up", "force"),
  "steal-ownership": removedFlag("up", "steal-ownership"),
  "resume-claim-owner": removedFlag("up", "resume-claim-owner"),
  "resume-claim-heartbeat": removedFlag("up", "resume-claim-heartbeat"),
  "resume-restore-owner": removedFlag("up", "resume-restore-owner"),
  "resume-restore-heartbeat": removedFlag("up", "resume-restore-heartbeat"),
  "max-concurrency": removedValueFlag("max-concurrency")
}

const up = Command.make("up", upFlags, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("up", {
      serve: config.serve,
      interactive: config.interactive,
      supervise: config.supervise,
      herdr: config.herdr,
      monitor: config.monitor,
      report: config.report,
      force: config.force,
      "steal-ownership": config["steal-ownership"],
      "resume-claim-owner": config["resume-claim-owner"],
      "resume-claim-heartbeat": config["resume-claim-heartbeat"],
      "resume-restore-owner": config["resume-restore-owner"],
      "resume-restore-heartbeat": config["resume-restore-heartbeat"],
      "max-concurrency": config["max-concurrency"]
    })
    if (Unsupported.isReservedFlow(config.flow)) {
      return yield* Effect.fail(Unsupported.reservedFlowError("up", config.flow))
    }
    const decodedInput = yield* decodeInput([], config.data)
    const control = yield* ControlService.Control
    const card = yield* control.plan({ flowId: config.flow, input: decodedInput })
    // Scope `run`: the approval authorizes this launch and its whole run, not
    // every future launch of the flow.
    yield* control.approve({ ...card.approval, scope: "run" })
    if (!config.detached) return yield* runLaunch({ ...card.approval, scope: "run" })

    const projectRoot = yield* Project.ProjectRoot
    const timeoutMs = Environment.readInteger(process.env, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    const launched = yield* Effect.promise(() =>
      Detached.launch({
        root: projectRoot,
        payload: JSON.stringify({ ...card.approval, scope: "run" }),
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
    )
    if (!Detached.isLaunched(launched)) {
      yield* Effect.sync(() => Detached.discard(launched))
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: launched.tail === "" ? launched.reason : `${launched.reason}\n${launched.tail}`
        })
      )
    }
    // The receipt's own field, never an operator-supplied id: rc.0 has no
    // `--run-id`, and a caller reads the run id from here.
    yield* render({ runId: launched.runId, logFile: launched.logFile, detached: true })
  })).pipe(Command.withDescription(Verb.find("up")!.help))

const approve = Command.make("approve", {
  approval: Argument.string("approval"),
  scope: Flag.choice("scope", ["once", "run", "remembered"] as const).pipe(Flag.withDefault("run"))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* decisionPark(control, payload.target)
    const receipt = yield* control.approve({ ...payload, scope: config.scope })
    // A decision restarts the run it answers, in this call, on this process's
    // own executor (rc-contract section 5.1). The decision therefore ends with
    // a settled run, and the shell that ran `smithers approve` is entitled to
    // read that run's status from `$?` exactly as `up` and `run` promise it.
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* render(receipt)
    yield* reportSettlement(settlement)
  })).pipe(Command.withDescription(Verb.find("approve")!.help))

const deny = Command.make("deny", { approval: Argument.string("approval") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* decisionPark(control, payload.target)
    const receipt = yield* control.deny(payload)
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* render(receipt)
    yield* reportSettlement(settlement)
  })).pipe(Command.withDescription(Verb.find("deny")!.help))

const cancel = Command.make("cancel", { runId: Argument.string("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* render(yield* control.cancel({ runId: config.runId, idempotencyKey: `cli:cancel:${config.runId}` }))
  })).pipe(Command.withDescription(Verb.find("cancel")!.help))

/**
 * The idempotency key of one signal delivery.
 *
 * The payload digest is part of the key because two different signals to one
 * run are two mutations. At the import reference the key was `cli:signal:<id>`
 * alone, so the second signal replayed the first one's recorded receipt and
 * was never delivered (rc-contract section 5.1).
 *
 * @category constructors
 * @since 1.0.0
 */
export const signalKey = (runId: string, payload: ControlSchema.SignalPayload): string => {
  const serialized = JSON.stringify(payload)
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `cli:signal:${runId}:${hash.toString(16).padStart(8, "0")}`
}

const signalCommand = Command.make("signal", {
  runId: Argument.string("run-id"),
  payload: Argument.string("signal-json")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* signal(config.payload)
    const control = yield* ControlService.Control
    yield* render(
      yield* control.signal({
        runId: config.runId,
        signal: payload,
        idempotencyKey: signalKey(config.runId, payload)
      })
    )
  })).pipe(Command.withDescription(Verb.find("signal")!.help))

const steer = Command.make("steer", {
  runId: Argument.string("run-id"),
  message: Flag.string("message"),
  takeover: removedFlag("steer", "takeover")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("steer", { takeover: config.takeover })
    const control = yield* ControlService.Control
    const stamp = Date.now()
    yield* render(
      yield* control.steer({
        runId: config.runId,
        message: {
          kind: "Message",
          messageId: `cli:steer:${config.runId}:${stamp}`,
          runId: config.runId,
          principal: { kind: "operator", id: "cli", stampedAt: stamp },
          createdAt: stamp,
          body: config.message
        },
        idempotencyKey: `cli:steer:${config.runId}:${stamp}`
      })
    )
  })).pipe(Command.withDescription(Verb.find("steer")!.help))

const listFlows = Effect.gen(function*() {
  yield* guardGlobals
  const control = yield* ControlService.Control
  const listed = yield* control.list({ _tag: "flows" })
  // The reserved catalog is the control plane's projection surface, not this
  // project's flows. Listing it invited `up system/release`, which planned,
  // launched, and then sat at `accepted` with nothing to run.
  yield* render(
    listed._tag === "flows"
      ? { ...listed, items: listed.items.filter((item) => !Unsupported.isReservedFlow(item.flowId)) }
      : listed
  )
})

const ls = Command.make("ls", {}, () => listFlows).pipe(Command.withDescription(Verb.find("ls")!.help))

const workflowList = Command.make("list", {}, () => listFlows).pipe(
  Command.withDescription("Alias of `ls`"),
  Command.unlisted
)

const workflow = Command.make(
  "workflow",
  { rest: Argument.string("subcommand").pipe(Argument.variadic()) },
  (config) => Effect.fail(Unsupported.verbError(removedVerb("workflow"), config.rest[0]))
).pipe(
  Command.withDescription("Removed; only `workflow list` survives, as an alias of `ls`"),
  Command.unlisted,
  Command.withSubcommands([workflowList])
)

const ps = Command.make("ps", {
  flow: Flag.string("flow").pipe(Flag.optional),
  // Validated, not cast: at the import reference any string reached the store
  // as a `RunStatus`, so `--status done` listed nothing and said nothing.
  status: Flag.choice(
    "status",
    [
      "accepted",
      "running",
      "parked",
      "waiting-approval",
      "cancelled",
      "completed",
      "failed"
    ] as const
  ).pipe(Flag.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* render(
      yield* control.list({
        _tag: "runs",
        filters: {
          ...(Option.isNone(config.flow) ? {} : { flowId: config.flow.value }),
          ...(Option.isNone(config.status) ? {} : { status: config.status.value })
        }
      })
    )
  })).pipe(Command.withDescription(Verb.find("ps")!.help))

const statusOf = (runId: Option.Option<string>) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const filters = Option.isSome(runId) ? { runId: runId.value } : undefined
    const listed = yield* control.list({ _tag: "runs", filters })
    const root = yield* rootCommand
    // `--json` keeps the stable listing shape untouched; a human reader with a
    // run id gets the diagnosis card computed from that run's own events.
    if (root.json || Option.isNone(runId)) return yield* render(listed)
    const events = yield* eventsOf(control, runId.value)
    const run = listed._tag === "runs" ? listed.items.find((item) => item.runId === runId.value) : undefined
    yield* render(Forensics.renderDiagnosis(run, Forensics.digest(events)))
  })

const status = Command.make("status", {
  runId: Argument.string("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(
  Command.withDescription(Verb.find("status")!.help),
  Command.withAlias("inspect")
)

const why = Command.make("why", {
  runId: Argument.string("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(Command.withDescription("Alias of `status`"), Command.unlisted)

const readLogs = (runId: Option.Option<string>, follow: boolean, forceJson: boolean) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const root = yield* rootCommand
    const json = forceJson || root.json
    const events = control.watch({
      runId: Option.getOrUndefined(runId),
      follow
    })
    // Human output is the transcript projection; `--json` remains the raw
    // event stream, byte-stable for scripts. Follow mode renders one line per
    // event as it lands, because a transcript needs the whole run.
    if (follow) {
      return yield* Stream.runForEach(
        events,
        (event) => json ? renderJson(event) : render(Forensics.eventLine(event))
      )
    }
    const collected = globalThis.Array.from(yield* Stream.runCollect(events))
    if (json) return yield* renderJson(collected)
    yield* render(Forensics.renderTranscript(collected))
  })

const logs = Command.make("logs", {
  runId: Argument.string("run-id").pipe(Argument.optional),
  follow: Flag.boolean("follow")
}, (config) => readLogs(config.runId, config.follow, false)).pipe(
  Command.withDescription(Verb.find("logs")!.help)
)

const events = Command.make("events", {
  runId: Argument.string("run-id").pipe(Argument.optional),
  follow: Flag.boolean("follow")
}, (config) => readLogs(config.runId, config.follow, true)).pipe(
  Command.withDescription("Alias of `logs --json`"),
  Command.unlisted
)

const output = Command.make("output", {
  runId: Argument.string("run-id"),
  nodeId: Argument.string("node-id").pipe(Argument.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const collected = yield* eventsOf(control, config.runId)
    const nodes = NodeOutput.project(collected)
    const requested = Option.getOrUndefined(config.nodeId)
    if (requested === undefined) return yield* render(nodes)
    const node = nodes.find((candidate) => candidate.nodeId === requested)
    if (node === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: NodeOutput.notFound(config.runId, requested, nodes) })
      )
    }
    const root = yield* rootCommand
    yield* render(root.json ? node : NodeOutput.render(node))
  })).pipe(Command.withDescription(Verb.find("output")!.help))

const down = Command.make("down", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const listed = yield* control.list({ _tag: "runs" })
    const runs = listed._tag === "runs"
      ? listed.items.filter((item) =>
        item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled"
      )
      : []
    const receipts = yield* Effect.forEach(runs, (item) =>
      Effect.map(
        control.cancel({ runId: item.runId, idempotencyKey: `cli:cancel:${item.runId}` }),
        (receipt) => ({ runId: item.runId, receipt })
      ))
    yield* render({ cancelled: receipts })
  })).pipe(Command.withDescription(Verb.find("down")!.help))

const init = Command.make("init", {
  name: Argument.string("name").pipe(Argument.optional),
  global: removedFlag("init", "global")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("init", { global: config.global })
    const projectRoot = yield* Project.ProjectRoot
    const name = Option.getOrElse(config.name, () => Init.defaultName(projectRoot))
    yield* render(yield* Effect.sync(() => Init.scaffold(projectRoot, name)))
  })).pipe(Command.withDescription(Verb.find("init")!.help))

const docs = Command.make("docs", { full: Flag.boolean("full") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const bundle = Docs.read(config.full)
    // A missing bundle is reported once, on stderr, with exit 1. Printing it
    // to stdout as well put the same paragraph in both streams and put an
    // error message inside the document a caller was piping somewhere.
    if (!bundle.found) return yield* Effect.fail(new CliError.UnsupportedError({ message: bundle.text }))
    yield* Console.log(bundle.text)
  })).pipe(Command.withDescription(Verb.find("docs")!.help))

/**
 * The migration tool's own flag set, declared on the verb.
 *
 * `smithers migrate` and `smithers-migrate` run the same entry, so they take
 * the same options. A verb that declared none of them could only ever plan:
 * `--apply` is what the section 4.1 row calls converting the project source,
 * and an operator who cannot type it has no way to reach the transformation.
 * `--json` is not repeated here because it is already a shared global.
 */
const migrateFlags = {
  scan: Flag.boolean("scan").pipe(
    Flag.withDescription("Inventory the project and write the report without planning any unit")
  ),
  apply: Flag.boolean("apply").pipe(
    Flag.withDescription("Convert the project source, instead of planning the conversion")
  ),
  seat: Flag.string("seat").pipe(
    Flag.withDescription("The model seat the migration's agent runs on"),
    Flag.optional
  ),
  allowUnsafe: Flag.string("allow-unsafe").pipe(
    Flag.withDescription("Accept the named unsafe constructs, or `all`"),
    Flag.optional
  ),
  acknowledgeRunState: Flag.boolean("acknowledge-run-state").pipe(
    Flag.withDescription("Accept the 0.x run state the report lists and migrate the source anyway")
  ),
  allowNoVcs: Flag.boolean("allow-no-vcs").pipe(
    Flag.withDescription("Accept a file copy as the only checkpoint, in a project under no version control")
  ),
  keepOldSources: Flag.boolean("keep-old-sources").pipe(
    Flag.withDescription("Leave the 0.x sources in place beside the flows written from them")
  ),
  unit: Flag.string("unit").pipe(
    Flag.withDescription("Migrate only these units, comma separated"),
    Flag.optional
  ),
  maxRepairRounds: Flag.integer("max-repair-rounds").pipe(
    Flag.withDescription("How many times one unit may be repaired before it is reported as failed"),
    Flag.optional
  ),
  reportDir: Flag.string("report-dir").pipe(
    Flag.withDescription("Where the report is written, relative to the project root"),
    Flag.optional
  ),
  flowsDir: Flag.string("flows-dir").pipe(
    Flag.withDescription("Where the written flows go, instead of `flows/`"),
    Flag.optional
  ),
  verifyInstall: Flag.string("verify-install").pipe(
    Flag.withDescription("The command that installs dependencies, instead of the one the lockfile implies"),
    Flag.optional
  ),
  verifyFormat: Flag.string("verify-format").pipe(
    Flag.withDescription("The command that formats the project, instead of the one its config implies"),
    Flag.optional
  ),
  verifyTypecheck: Flag.string("verify-typecheck").pipe(
    Flag.withDescription(
      "The command that typechecks the project, repeatable; one empty value runs no typecheck at all"
    ),
    Flag.atLeast(0)
  ),
  verifyTest: Flag.string("verify-test").pipe(
    Flag.withDescription("The command that runs the tests, instead of the project's own test script"),
    Flag.optional
  )
}

const migrate = Command.make("migrate", {
  path: Argument.string("path").pipe(Argument.optional),
  to: removedValueFlag("to"),
  ...migrateFlags
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("migrate", { to: config.to })
    // The 0.x project, not the rc.0 one. `Project.ProjectRoot` anchors its
    // walk on `.flows/`, which a 0.x project does not have, so a project
    // nested under an rc.0 one was scanned — and with `--apply`, rewritten —
    // at the ancestor instead of itself.
    const migrationRoot = yield* Project.MigrationRoot
    const target = Option.getOrElse(config.path, () => migrationRoot)
    // `legacyDatabases`, not `legacyState`: the section 6 refusal is not
    // gated on `.flows/` being absent, and the project being migrated has
    // one by definition.
    const databases = Project.legacyDatabases(target).map(Legacy.read)
    const refusal = Legacy.refusal(databases)
    if (refusal !== undefined) return yield* Effect.fail(new CliError.UnsupportedError({ message: refusal }))
    // The flow ships inside `@smthrs/migrate`, which is where a 0.x project can
    // reach it: such a project has no `flows/` directory by definition, so
    // looking for `flows/**/migrate-smithers-v1` made the verb unreachable for
    // every project it exists for. This is the same entry `smithers-migrate`
    // runs, so the two spellings are one implementation.
    const options = MigrateCommand.optionsOf({
      root: target,
      scan: config.scan,
      apply: config.apply,
      seat: Option.getOrUndefined(config.seat),
      allowUnsafe: Option.getOrUndefined(config.allowUnsafe),
      acknowledgeRunState: config.acknowledgeRunState,
      allowNoVcs: config.allowNoVcs,
      keepOldSources: config.keepOldSources,
      unit: Option.getOrUndefined(config.unit),
      maxRepairRounds: Option.getOrUndefined(config.maxRepairRounds),
      reportDir: Option.getOrUndefined(config.reportDir),
      flowsDir: Option.getOrUndefined(config.flowsDir),
      verifyInstall: Option.getOrUndefined(config.verifyInstall),
      verifyFormat: Option.getOrUndefined(config.verifyFormat),
      verifyTypecheck: config.verifyTypecheck,
      verifyTest: Option.getOrUndefined(config.verifyTest)
    }, target)
    const root = yield* rootCommand
    const outcome = yield* Effect.result(MigrateCommand.runNode(options, { environment: process.env }))
    if (outcome._tag === "Failure") {
      const error = outcome.failure
      // A refused gate is not a crash: it prints the operator's own
      // instructions and leaves the project untouched. The two gates that park
      // for a decision exit 3, the way `smithers-migrate` and every parked
      // Smithers run report one.
      const message = `smithers migrate: ${error.message}${error.details === undefined ? "" : `\n${error.details}`}`
      if (error.code === "run-state-blocked" || error.code === "unsafe-blocked") {
        yield* Console.error(message)
        return yield* Effect.sync(() => {
          process.exitCode = 3
        })
      }
      return yield* Effect.fail(new CliError.UnsupportedError({ message }))
    }
    const report = outcome.success
    if (!root.quiet) {
      yield* Console.log(
        MigrateCommand.render(report, root.json ? "json" : "human", MigrateCommand.reportDirectory(options))
      )
    }
    // The migration's own status, the way `smithers-migrate` reports it: 3 is
    // "parked, the operator has a decision", not a failure. `bin.ts` hands a
    // successful exit whatever `process.exitCode` holds, which is also how
    // `NodeControl.layerOutput` transfers a rendered status.
    yield* Effect.sync(() => {
      process.exitCode = MigrateCommand.exitCode(report)
    })
  })).pipe(Command.withDescription(Verb.find("migrate")!.help))

const memoryNamespace = (raw: Option.Option<string>): Namespace.Namespace => {
  const value = Option.getOrElse(raw, () => "user:cli")
  const separator = value.indexOf(":")
  const kind = separator < 0 ? "user" : value.slice(0, separator)
  const id = separator < 0 ? value : value.slice(separator + 1)
  const known = kind === "flow" || kind === "agent" || kind === "user" || kind === "global"
  return { kind: known ? kind : "user", id: id === "" ? "cli" : id }
}

const memoryFlags = { namespace: Flag.string("namespace").pipe(Flag.optional) }

const memoryList = Command.make("list", { ...memoryFlags, prefix: Flag.string("prefix").pipe(Flag.optional) }, (
  config
) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const store = yield* MemoryStore.MemoryStore
    const facts = yield* store.listFacts({
      namespace: memoryNamespace(config.namespace),
      ...(Option.isNone(config.prefix) ? {} : { prefix: config.prefix.value })
    })
    yield* render(facts.map((fact) => ({ key: fact.key, value: fact.value, updatedAtMs: fact.updatedAtMs })))
  })).pipe(Command.withDescription("List facts in a memory namespace"))

const memoryGet = Command.make(
  "get",
  { ...memoryFlags, key: Argument.string("key") },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      const store = yield* MemoryStore.MemoryStore
      const fact = yield* store.getFact({ namespace: memoryNamespace(config.namespace), key: config.key })
      if (fact === undefined) {
        return yield* Effect.fail(new CliError.UsageError({ message: `No fact ${config.key} in this namespace` }))
      }
      yield* render(fact.value)
    })
).pipe(Command.withDescription("Read one fact"))

const memorySet = Command.make("set", {
  ...memoryFlags,
  key: Argument.string("key"),
  value: Argument.string("value")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const store = yield* MemoryStore.MemoryStore
    // A value that parses as JSON is stored as JSON; anything else is the
    // string as typed. An operator writing `{"a":1}` means the object.
    let parsed: unknown = config.value
    try {
      parsed = JSON.parse(config.value)
    } catch {
      parsed = config.value
    }
    yield* store.putFact({
      namespace: memoryNamespace(config.namespace),
      key: config.key,
      value: parsed,
      provenance: {}
    })
    yield* render({ key: config.key, written: true })
  })).pipe(Command.withDescription("Write one fact"))

const memoryRm = Command.make(
  "rm",
  { ...memoryFlags, key: Argument.string("key") },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      const store = yield* MemoryStore.MemoryStore
      const removed = yield* store.deleteFact({ namespace: memoryNamespace(config.namespace), key: config.key })
      yield* render({ key: config.key, removed })
    })
).pipe(Command.withDescription("Delete one fact"))

const memory = Command.make("memory").pipe(
  Command.withDescription(Verb.find("memory")!.help),
  Command.withSubcommands([memoryList, memoryGet, memorySet, memoryRm])
)

const claudeSession = Flag.string("session").pipe(Flag.optional)

const sessionId = (raw: Option.Option<string>): string =>
  Option.getOrElse(raw, () => process.env["CLAUDE_CODE_SESSION_ID"] ?? "unknown")

const claudeTick = Command.make("tick", {
  runId: Argument.string("run-id"),
  session: claudeSession,
  afterSeq: Flag.integer("after-seq").pipe(Flag.withDefault(0))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const projectRoot = yield* Project.ProjectRoot
    // Following a run is subscribing: every tick re-asserts the entry, so a
    // registry lost to a crash repairs itself on the next frame.
    yield* Effect.sync(() => ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session)))
    const collected = yield* eventsOf(control, config.runId)
    const run = yield* summaryOf(control, config.runId)
    const digest = Forensics.digest(collected)
    yield* renderJson(
      ClaudeMirror.frame(config.runId, run, collected, {
        afterSeq: config.afterSeq,
        parked: { question: digest.parkedQuestion, approval: digest.parkedApproval }
      })
    )
  })).pipe(Command.withDescription("Print one mirror frame for a run"))

const claudeNodeWait = Command.make("node-wait", {
  runId: Argument.string("run-id"),
  nodeId: Argument.string("node-id"),
  timeout: Flag.integer("timeout-ms").pipe(Flag.withDefault(30_000))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const deadline = Date.now() + config.timeout
    for (;;) {
      const collected = yield* eventsOf(control, config.runId)
      const node = NodeOutput.find(collected, config.nodeId)
      if (node !== undefined && node.outcome !== "pending") return yield* renderJson({ ...node, timedOut: false })
      const run = yield* summaryOf(control, config.runId)
      if (run !== undefined && ClaudeMirror.isTerminal(run.status)) {
        return yield* renderJson({ nodeId: config.nodeId, outcome: "vanished", status: run.status, timedOut: false })
      }
      if (Date.now() >= deadline) {
        return yield* renderJson({ nodeId: config.nodeId, outcome: "pending", timedOut: true })
      }
      yield* Effect.sleep("250 millis")
    }
  })).pipe(Command.withDescription("Block until one node settles"))

const claudeMonitor = Command.make("monitor", {
  session: claudeSession,
  allRuns: Flag.boolean("all-runs"),
  limit: Flag.integer("limit").pipe(Flag.withDefault(200))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const projectRoot = yield* Project.ProjectRoot
    const followed = config.allRuns
      ? undefined
      : new Set(
        ClaudeMirror.readSubscriptions(projectRoot)
          .filter((entry) => entry.sessionId === sessionId(config.session))
          .map((entry) => entry.runId)
      )
    const collected = globalThis.Array.from(yield* Stream.runCollect(control.watch({ follow: false })))
    const lines = collected
      .flatMap((event) => {
        const line = ClaudeMirror.transition(event)
        if (line === undefined) return []
        if (followed !== undefined && !followed.has(line.runId)) return []
        return [line]
      })
      .slice(-config.limit)
    for (const line of lines) yield* Console.log(JSON.stringify(line))
  })).pipe(Command.withDescription("Print notable run transitions as NDJSON"))

const claudeSubscribe = Command.make("subscribe", {
  runId: Argument.string("run-id"),
  session: claudeSession
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const entries = yield* Effect.sync(() =>
      ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session))
    )
    yield* renderJson({ subscriptions: entries.length })
  })).pipe(Command.withDescription("Follow a run in this session's mirror"))

const claudeUnsubscribe = Command.make("unsubscribe", {
  runId: Argument.string("run-id"),
  session: claudeSession
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const entries = yield* Effect.sync(() =>
      ClaudeMirror.unsubscribe(projectRoot, config.runId, sessionId(config.session))
    )
    yield* renderJson({ subscriptions: entries.length })
  })).pipe(Command.withDescription("Stop following a run in this session's mirror"))

const claude = Command.make("claude").pipe(
  Command.withDescription(Verb.find("claude")!.help),
  Command.withSubcommands([claudeTick, claudeNodeWait, claudeMonitor, claudeSubscribe, claudeUnsubscribe])
)

const mcpAdd = Command.make("add", {
  agent: Flag.string("agent").pipe(Flag.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const requested = Option.getOrUndefined(config.agent)
    const targets = requested === undefined
      ? Agents.agents
      : Agents.find(requested) === undefined
      ? []
      : [Agents.find(requested)!]
    if (targets.length === 0) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: `Unknown agent ${requested}. Known agents: ${Agents.agents.map((agent) => agent.id).join(", ")}`
        })
      )
    }
    const wired = yield* Effect.sync(() => targets.map((agent) => Agents.addMcp(agent)))
    if (wired.every((entry) => entry.status === "failed")) {
      yield* Console.error(Agents.manualInstructions(targets.map((agent) => agent.id)))
      return yield* Effect.fail(new CliError.UnsupportedError({ message: "Could not register the MCP server" }))
    }
    yield* render(wired)
  })).pipe(Command.withDescription("Register the Smithers MCP server with an agent"))

const mcp = Command.make("mcp").pipe(
  Command.withDescription(Verb.find("mcp")!.help),
  Command.withSubcommands([mcpAdd])
)

const skillsAdd = Command.make(
  "add",
  { agent: Flag.string("agent").pipe(Flag.optional) },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      const requested = Option.getOrUndefined(config.agent)
      const targets = requested === undefined ? Agents.agents : Agents.agents.filter((agent) => agent.id === requested)
      if (targets.length === 0) {
        return yield* Effect.fail(
          new CliError.UsageError({
            message: `Unknown agent ${requested}. Known agents: ${Agents.agents.map((agent) => agent.id).join(", ")}`
          })
        )
      }
      // rc-contract ruling F2: the one curated skill, or nothing. Rendering a
      // stub from the verb table and reporting success put a document under
      // the curated skill's name that carried none of what it teaches.
      const curated = Agents.skill()
      if (curated._tag === "missing") {
        return yield* Effect.fail(new CliError.UnsupportedError({ message: Agents.skillMissing(curated.searched) }))
      }
      yield* render(yield* Effect.sync(() => targets.map((agent) => Agents.addSkill(agent, curated.contents))))
    })
).pipe(Command.withDescription("Install the smithers skill into an agent"))

const skillsList = Command.make("list", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* render(yield* Effect.sync(() => Agents.listSkills()))
  })).pipe(Command.withDescription("Report where the smithers skill is installed"))

const skills = Command.make("skills").pipe(
  Command.withDescription(Verb.find("skills")!.help),
  Command.withSubcommands([skillsAdd, skillsList])
)

const update = Command.make("update", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    const tags = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(Update.registryUrl, { signal: AbortSignal.timeout(10_000) })
        return await response.json() as Record<string, string>
      },
      catch: (error) =>
        new CliError.UnsupportedError({
          message: `Could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`
        })
    })
    yield* render(Update.render(Update.compare(packageVersion, tags)))
  })).pipe(Command.withDescription(Verb.find("update")!.help))

const bug = Command.make("bug", {
  summary: Argument.string("summary").pipe(Argument.variadic()),
  runId: Flag.string("run").pipe(Flag.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const summary = config.summary.join(" ").trim()
    if (summary === "") {
      return yield* Effect.fail(new CliError.UsageError({ message: "smithers bug needs a one-line summary" }))
    }
    const control = yield* ControlService.Control
    const listed = yield* control.list({ _tag: "runs" })
    const digest = Option.isNone(config.runId)
      ? undefined
      : Forensics.digest(yield* eventsOf(control, config.runId.value))
    const body = Bug.report({
      summary,
      version: packageVersion,
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      runs: listed._tag === "runs" ? listed.items : [],
      ...(digest === undefined ? {} : { digest })
    })
    const endpoint = Environment.read(process.env, "SMITHERS_BUG_ENDPOINT") ?? Bug.defaultEndpoint
    const posted = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Bug.timeoutMs)
        })
        return { status: response.status, ok: response.ok }
      },
      catch: (error) =>
        new CliError.UnsupportedError({
          message: `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
        })
    })
    if (!posted.ok) {
      return yield* Effect.fail(
        new CliError.UnsupportedError({ message: `${endpoint} answered ${posted.status}` })
      )
    }
    yield* render({ reported: true, endpoint })
  })).pipe(Command.withDescription(Verb.find("bug")!.help))

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const jj = ResolveJj.resolveJjBinary()
    const report = Doctor.inspect({ root: projectRoot, jj, legacyPaths: yield* Project.LegacyState })
    const root = yield* rootCommand
    yield* render(root.json ? report : Doctor.render(report))
    if (Doctor.failed(report)) {
      yield* Effect.fail(new CliError.UnsupportedError({ message: "doctor found a blocking problem" }))
    }
  })).pipe(Command.withDescription(Verb.find("doctor")!.help))

const gc = Command.make("gc", {
  olderThan: Flag.string("older-than").pipe(Flag.withDefault(Gc.defaultRetention)),
  dryRun: Flag.boolean("dry-run")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const swept = yield* Gc.sweep(projectRoot, { olderThan: config.olderThan, dryRun: config.dryRun })
    yield* render(swept)
    // The report is rendered either way, so a `--json` caller still sees what
    // the readable databases held; the status is what tells a script that the
    // sweep was partial.
    if (swept.failures.length > 0) {
      return yield* Effect.fail(new CliError.UnsupportedError({ message: Gc.failureMessage(swept.failures) }))
    }
  })).pipe(Command.withDescription(Verb.find("gc")!.help))

const serveFlags = {
  host: Flag.string("host").pipe(Flag.withDefault(Serve.defaultBind.host)),
  port: Flag.integer("port").pipe(Flag.withDefault(Serve.defaultBind.port)),
  listen: Flag.boolean("listen")
}

const serveHandler = (config: { readonly host: string; readonly port: number; readonly listen: boolean }) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const root = yield* rootCommand
    const credential = Option.getOrUndefined(root.credential) ??
      Environment.read(process.env, "SMITHERS_API_KEY")
    const bind: Serve.Bind = {
      host: config.host,
      port: config.port,
      listen: config.listen,
      credential
    }
    const refusal = Serve.refuse(bind)
    if (refusal !== undefined) return yield* Effect.fail(refusal)
    const projectRoot = yield* Project.ProjectRoot
    if (!root.quiet) yield* Console.error(Serve.banner(bind))
    yield* Serve.host(bind, projectRoot)
  })

const serveCommand = Command.make("serve", serveFlags, serveHandler).pipe(
  Command.withDescription(Verb.find("serve")!.help)
)

/**
 * `gateway`: the rc.0-only alias of `serve`, and the two subcommands section
 * 4.2 removed.
 *
 * It is a command group rather than `Command.withAlias("gateway")` because an
 * alias has no subcommands: `gateway status` reached the parser as a stray
 * positional argument and exited 2 with serve's usage text, which tells an
 * operator migrating a script nothing about where the gateway lifecycle went.
 */
const gatewaySubcommand = (name: string) =>
  Command.make(name, {}, () => Effect.fail(Unsupported.verbError(removedVerb("gateway"), name))).pipe(
    Command.withDescription(`Removed in 1.0.0-rc.0: ${removedVerb("gateway").reason}`),
    Command.unlisted
  )

const gatewayCommand = Command.make("gateway", serveFlags, serveHandler).pipe(
  Command.withDescription("Alias of `serve`; `gateway status` and `gateway stop` were removed"),
  Command.unlisted,
  Command.withSubcommands(Unsupported.removedVerbs.find((verb) => verb.name === "gateway")!.subcommands!.map(
    gatewaySubcommand
  ))
)

// == section 4.2 refusals

/**
 * Every removed verb, as a hidden subcommand that exits 1 with its reason.
 *
 * `workflows` is registered here under its own spelling like the rest. The
 * singular `workflow` is a separate command group, because `workflow list`
 * survives as the `ls` alias, and it refuses on its own with the same reason.
 */
const removedCommands = Unsupported.removedVerbs
  .filter((verb) => !ownGroupCommands.has(verb.name))
  .map((verb) =>
    Command.make(
      verb.name,
      { rest: Argument.string("argument").pipe(Argument.variadic()) },
      (config) => Effect.fail(Unsupported.verbError(verb, verb.subcommands === undefined ? undefined : config.rest[0]))
    ).pipe(
      Command.withDescription(`Removed in 1.0.0-rc.0: ${verb.reason}`),
      Command.unlisted
    )
  )

/**
 * The composed root command. Application composition supplies Control and
 * Output layers; this module contains no transport selection.
 *
 * @category constructors
 * @since 1.0.0
 * @slop
 */
export const cli = rootCommand.pipe(
  Command.withDescription("Plan, approve, and run durable flows"),
  Command.withSubcommands([
    plan,
    run,
    resume,
    up,
    approve,
    deny,
    cancel,
    signalCommand,
    steer,
    ls,
    workflow,
    ps,
    status,
    why,
    logs,
    events,
    output,
    down,
    serveCommand,
    gatewayCommand,
    init,
    doctor,
    docs,
    gc,
    migrate,
    memory,
    claude,
    mcp,
    skills,
    update,
    bug,
    ...removedCommands
  ])
)
