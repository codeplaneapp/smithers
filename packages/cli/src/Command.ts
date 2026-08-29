/**
 * The Effect CLI command tree for flows.
 *
 * @since 0.1.0
 */
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import { Console, Effect, Option, Schema, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as CliError from "./CliError.ts"
import * as ExecutorOwnership from "./ExecutorOwnership.ts"
import * as Forensics from "./Forensics.ts"
import { Output } from "./Output.ts"
import { find } from "./Verb.ts"

const global = {
  credential: Flag.string("credential").pipe(Flag.optional),
  json: Flag.boolean("json"),
  remote: Flag.string("remote").pipe(Flag.optional),
  quiet: Flag.boolean("quiet"),
  // Declared here so the CLI's own flag validation accepts it; the value is
  // read from raw argv by `NodeControl.makeConfig`, the same as `remote` and
  // `credential` are.
  mcpConfig: Flag.string("mcp-config").pipe(Flag.optional)
}

const rootCommand = Command.make("flows").pipe(Command.withSharedFlags(global))
const input = Argument.string("key=value").pipe(Argument.variadic())
const data = Flag.string("data").pipe(Flag.optional)
const common = { input, data }

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

const awaitRun = (
  control: ControlService.Service,
  runId: string,
  afterSequence: number | undefined
): Effect.Effect<void, never> =>
  control.watch(afterSequence === undefined ? { runId } : { runId, afterSequence }).pipe(
    Stream.filter((event) => settled(event.kind)),
    Stream.take(1),
    Stream.runDrain,
    // A transport failure still lets the process close normally; remote CLI
    // ownership belongs to the server, and the receipt was already durable.
    Effect.catchCause(() => Effect.void)
  )

/**
 * The sequence of the latest committed `control.run.waiting-approval` event:
 * the park a resume applies to. It keys the resume mutation, so resuming a
 * second park is a fresh mutation instead of a replay of the first resume's
 * recorded receipt, and it scopes the settlement wait — `watch` replays
 * committed history before following, so waiting only on events after the
 * resumed park keeps the wait live for a later park without matching this one.
 */
const latestPark = (
  control: ControlService.Service,
  runId: string
): Effect.Effect<number | undefined, never> =>
  control.watch({ runId, follow: false }).pipe(
    Stream.filter((event) => event.kind === "control.run.waiting-approval"),
    Stream.runCollect,
    Effect.map((events) => events.length === 0 ? undefined : Math.max(...events.map((event) => event.sequence))),
    Effect.catchCause(() => Effect.succeed(undefined))
  )

const awaitOwnedRun = (
  control: ControlService.Service,
  receipt: ControlSchema.Receipt,
  afterSequence: number | undefined
): Effect.Effect<void, never> =>
  Effect.gen(function*() {
    const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
    if (!ownsExecutor || receipt._tag !== "Accepted" || receipt.runId === undefined) return
    yield* awaitRun(control, receipt.runId, afterSequence)
  })

const plan = Command.make("plan", common, (config) =>
  Effect.gen(function*() {
    const decodedInput = yield* decodeInput(config.input.slice(1), config.data)
    const control = yield* ControlService.Control
    const flowId = config.input[0] ?? ""
    const card = yield* control.plan({ flowId, input: decodedInput })
    yield* render(card)
  })).pipe(Command.withDescription("Render a flow plan and its complete approval payload"))

const run = Command.make("run", {
  plan: Argument.string("plan-payload"),
  resume: Flag.boolean("resume")
}, (config) =>
  Effect.gen(function*() {
    if (config.resume) {
      const control = yield* ControlService.Control
      const parkSequence = yield* latestPark(control, config.plan)
      const receipt = yield* control.resume({
        runId: config.plan,
        idempotencyKey: parkSequence === undefined
          ? `cli:resume:${config.plan}`
          : `cli:resume:${config.plan}:${parkSequence}`
      })
      yield* awaitOwnedRun(control, receipt, parkSequence)
      return yield* render(receipt)
    }
    const payload = yield* approval(config.plan)
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
    yield* awaitOwnedRun(control, receipt, undefined)
    yield* render(receipt)
  })).pipe(Command.withDescription("Run an approved plan payload, or resume a parked run"))

const approve = Command.make("approve", {
  approval: Argument.string("approval"),
  scope: Flag.choice("scope", ["once", "run", "remembered"] as const).pipe(Flag.withDefault("run"))
}, (config) =>
  Effect.gen(function*() {
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const receipt = yield* control.approve({ ...payload, scope: config.scope })
    yield* render(receipt)
  })).pipe(Command.withDescription("Approve the complete serialized plan approval payload"))

const deny = Command.make("deny", {
  approval: Argument.string("approval")
}, (config) =>
  Effect.gen(function*() {
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const receipt = yield* control.deny(payload)
    yield* render(receipt)
  })).pipe(Command.withDescription("Deny the complete serialized plan approval payload"))

const cancel = Command.make("cancel", {
  runId: Argument.string("run-id")
}, (config) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    yield* render(yield* control.cancel({ runId: config.runId, idempotencyKey: `cli:cancel:${config.runId}` }))
  })).pipe(Command.withDescription("Cancel a durable run"))

const signalCommand = Command.make("signal", {
  runId: Argument.string("run-id"),
  payload: Argument.string("signal-json")
}, (config) =>
  Effect.gen(function*() {
    const payload = yield* signal(config.payload)
    const control = yield* ControlService.Control
    yield* render(
      yield* control.signal({
        runId: config.runId,
        signal: payload,
        idempotencyKey: `cli:signal:${config.runId}`
      })
    )
  })).pipe(Command.withDescription("Deliver a durable JSON signal to a run"))

const ls = Command.make("ls", {}, () =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    yield* render(yield* control.list({ _tag: "flows" }))
  })).pipe(Command.withDescription("List available flows"))

const ps = Command.make("ps", {
  flow: Flag.string("flow").pipe(Flag.optional),
  status: Flag.string("status").pipe(Flag.optional)
}, (config) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const filters = {
      flowId: Option.getOrUndefined(config.flow),
      status: Option.getOrUndefined(config.status) as ControlSchema.RunStatus | undefined
    }
    yield* render(yield* control.list({ _tag: "runs", filters }))
  })).pipe(Command.withDescription("List durable runs"))

const status = Command.make("status", {
  runId: Argument.string("run-id").pipe(Argument.optional)
}, (config) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const filters = Option.isSome(config.runId) ? { runId: config.runId.value } : undefined
    const listed = yield* control.list({ _tag: "runs", filters })
    const root = yield* rootCommand
    // The vault's Forensics note makes `status` the run-summary projection,
    // gating cause included. With a run id and a human reader, the summary is
    // the diagnosis card computed from the run's own events; `--json` keeps
    // the stable listing shape untouched.
    if (root.json || Option.isNone(config.runId)) {
      return yield* render(listed)
    }
    const runId = config.runId.value
    const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
    const run = listed._tag === "runs"
      ? listed.items.find((item) => item.runId === runId)
      : undefined
    yield* render(Forensics.renderDiagnosis(run, Forensics.digest(globalThis.Array.from(events))))
  })).pipe(Command.withDescription("Show control status"))

const logs = Command.make("logs", {
  runId: Argument.string("run-id").pipe(Argument.optional),
  follow: Flag.boolean("follow")
}, (config) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const root = yield* rootCommand
    const events = control.watch({
      runId: Option.getOrUndefined(config.runId),
      follow: config.follow
    })
    // Human output is the transcript projection; `--json` remains the raw
    // event stream, byte-stable for scripts. Follow mode renders one line per
    // event as it lands, because a transcript needs the whole run.
    if (config.follow) {
      return yield* Stream.runForEach(
        events,
        (event) => root.json ? render(event) : render(Forensics.eventLine(event))
      )
    }
    const collected = yield* Stream.runCollect(events)
    if (root.json) return yield* render(collected)
    yield* render(Forensics.renderTranscript(globalThis.Array.from(collected)))
  })).pipe(Command.withDescription("Read run events; --follow streams future events"))

const up = Command.make("up", {
  flow: Argument.string("flow").pipe(Argument.optional),
  watch: Flag.boolean("watch")
}, (config) =>
  Effect.gen(function*() {
    if (Option.isSome(config.flow)) return yield* Console.log(`did you mean \`flows run ${config.flow.value}\`?`)
    const control = yield* ControlService.Control
    const metadata = find("up")!
    const card = yield* control.plan({ flowId: metadata.flowId, input: { watch: config.watch } })
    yield* render(card)
  })).pipe(Command.withDescription("Boot the local stack; --watch enables development mode"))

const systemCommand = (verb: string) => {
  const metadata = find(verb)!
  return Command.make(verb, common, (config) =>
    Effect.gen(function*() {
      const decodedInput = yield* decodeInput(config.input, config.data)
      const control = yield* ControlService.Control
      const card = yield* control.plan({ flowId: metadata.flowId, input: decodedInput })
      // Plan-bearing and deploy-class system flows stop at the complete reviewable
      // card. Only the envelope carried by that card may be passed to `flows run`.
      yield* render(card)
    })).pipe(Command.withDescription(metadata.help))
}

/**
 * The composed root command. Application composition supplies Control and
 * Output layers; this module contains no transport or Node selection.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const cli = rootCommand.pipe(
  Command.withDescription("Plan, approve, and run durable flows"),
  Command.withSubcommands([
    plan,
    run,
    systemCommand("release"),
    systemCommand("serve"),
    up,
    ls,
    ps,
    logs,
    status,
    cancel,
    approve,
    deny,
    signalCommand,
    systemCommand("replay"),
    systemCommand("add"),
    systemCommand("remove"),
    systemCommand("eject"),
    systemCommand("test"),
    systemCommand("init"),
    systemCommand("doctor"),
    systemCommand("migrate"),
    systemCommand("docs")
  ])
)
