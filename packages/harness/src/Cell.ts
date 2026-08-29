/**
 * The cell contract.
 *
 * A Smithers frame is `model -> generated cell -> realm evaluation ->
 * individually durable flow calls -> next transition`. This module owns the
 * serializable half of that sentence: the cell source the model emits, the
 * transition the cell settled, the typed outcomes a cell may settle with, and
 * the identity carried by every flow call made inside one.
 *
 * Nothing here executes anything. Execution is `Sandbox`; durability is
 * `EngineLike.call`; the loop is `CellTurn`.
 *
 * A cell does not *return* its transition. The realm is a REPL that outlives
 * the cell, so a cell states its intent by calling `ctx.done` or `ctx.park` and
 * `Sandbox.replTransition` builds the value; there is no returned object to
 * decode. What the cell filed by hand — durable state, a projected context, a
 * list of keys to re-render, a list of ordinals to recall — is gone with the
 * surface that asked for it, and the fields survive here for one purpose only:
 * decoding the journals that were written while it existed.
 *
 * Governing design: `docs/specs/Concepts/Durable Cell Loop.md`,
 * `docs/specs/Concepts/Repl Realm.md` and
 * `docs/specs/Concepts/Agent Cell Context.md`.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Option, Result, Schema } from "effect"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The source language a cell is written in.
 *
 * Both shipped bindings run a `typescript` cell by erasing its type-only
 * syntax — never by emitting new runtime behaviour, so a construct that needs
 * JavaScript emit is a `compile_failed` rejection rather than a silent
 * transform. A binding that cannot compile at all rejects with
 * `unsupported_language`; neither shipped binding needs to.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Language = Schema.Literals(["javascript", "typescript"])

/**
 * The source language a cell is written in.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Language = typeof Language.Type

/**
 * One unit of agent-authored source and its stable content digest.
 *
 * The digest is part of every call identity produced inside the cell, so
 * editing one character of the source re-keys every boundary within it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Source extends Schema.Class<Source>("flows/harness/Cell/Source")({
  language: Language,
  text: Schema.String,
  digest: Schema.String
}) {}

/**
 * Computes the stable digest of cell source.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const digestOf = (language: Language, text: string): string =>
  Digest.digest(CanonicalJson.stringify({ kind: "flows/harness/Cell/Source", language, text }))

/**
 * Constructs cell source with its computed digest.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const source = (text: string, language: Language = "javascript"): Source =>
  new Source({ language, text, digest: digestOf(language, text) })

/**
 * One projected message a filing cell placed in the next model context.
 *
 * **Deprecated: decode-only.** It is the element type of {@link Continue}
 * `context`, and nothing constructs one any more. See that field.
 *
 * @category models
 * @since 0.1.0
 * @deprecated
 * @slop
 */
export class ContextEntry extends Schema.Class<ContextEntry>("flows/harness/Cell/ContextEntry")({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String
}) {}

/**
 * The cell's turn ended without settling the run.
 *
 * A REPL cell that calls neither `ctx.done` nor `ctx.park` gets another frame,
 * and this is what that frame is journaled as. The only thing it carries is a
 * justification, because everything else a `continue` used to carry was the
 * filing surface's bookkeeping and the realm holds it now.
 *
 * The four deprecated fields below are decode-only. They stay on the schema —
 * rather than behind a versioned decoder — because a journal payload carries no
 * version to switch on: the events are read back by decoding this very class,
 * so one schema that accepts both shapes is the only mechanism that leaves the
 * r90–r96 waves readable. They are optional, nothing populates them, and no
 * behaviour reads them.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Continue extends Schema.TaggedClass<Continue>("flows/harness/Cell/Continue")("continue", {
  /**
   * The JSON a filing cell filed for its successor.
   *
   * **Deprecated: decode-only.** The realm is the run's memory now — a name a
   * cell binds is still bound in the next cell — so there is nothing to file
   * and nothing to re-read. See `docs/specs/Concepts/Repl Realm.md`.
   *
   * @deprecated
   */
  state: Schema.optional(Schema.Json),
  /**
   * The exact messages a filing cell chose for its successor's context.
   *
   * **Deprecated: decode-only.** A REPL run's window is
   * `[cell₁, prints₁], [cell₂, prints₂], …`, appended rather than replaced, so
   * what the next turn reads is what the cell printed.
   *
   * @deprecated
   */
  context: Schema.optional(Schema.Array(ContextEntry)),
  /**
   * Ordinals of settled calls a filing cell asked to be shown again.
   *
   * **Deprecated: decode-only.** A REPL run's results are under the names its
   * cells gave them, so there is nothing to recall.
   *
   * @deprecated
   */
  recall: Schema.optional(Schema.Array(Schema.Number)),
  /**
   * Durable-state keys a filing cell asked to be shown in full.
   *
   * **Deprecated: decode-only.** The sibling of `state`, and gone with it.
   *
   * @deprecated
   */
  render: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Why this frame changed nothing, when the controller demanded that it
   * either mutate or say why not.
   *
   * The field exists because prose in the prompt did not stop a run from
   * reading for its whole budget: a benchmark instance spent 100 frames and
   * 132 calls without one edit attempt and then claimed the fix was
   * implemented. A justification is the typed way out of the read-only cap —
   * it is recorded, it buys a bounded grace, and it does not reset the
   * counter that eventually stops the run. A cell writes one by calling
   * `ctx.justify`.
   */
  justification: Schema.optional(Schema.String)
}) {}

/**
 * The cell declares the task finished and supplies its final output.
 *
 * A completion carries no self-reported proof. The run's evidence is the calls
 * it actually made — every one journaled as `cell-call-settled` with its real
 * input and result — and a field in which the model restates which of them
 * proved the work would be a claim about a check rather than the check.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Complete extends Schema.TaggedClass<Complete>("flows/harness/Cell/Complete")("complete", {
  /**
   * The JSON a filing cell filed alongside its answer.
   *
   * **Deprecated: decode-only.** See {@link Continue} `state`.
   *
   * @deprecated
   */
  state: Schema.optional(Schema.Json),
  output: Schema.String,
  reason: Schema.optional(Schema.String)
}) {}

/**
 * The cell asks the controller to park the run durably.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Park extends Schema.TaggedClass<Park>("flows/harness/Cell/Park")("park", {
  /**
   * The JSON a filing cell filed alongside its question.
   *
   * **Deprecated: decode-only.** See {@link Continue} `state`.
   *
   * @deprecated
   */
  state: Schema.optional(Schema.Json),
  reason: Schema.Literals(["waiting-input", "waiting-event", "waiting-quota"]),
  message: Schema.String
}) {}

/**
 * The serializable decision one cell returns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Transition = Schema.Union([Continue, Complete, Park]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * The serializable decision one cell returns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Transition = typeof Transition.Type

/**
 * Renders a projected value as the text one context entry carries.
 *
 * A string is itself. Everything else is canonical JSON, which is the whole of
 * the "render structs as JSON, always" rule: a structured value reaches the
 * next model turn as the value it is.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const renderText = (value: Schema.Json): string =>
  typeof value === "string" ? value : CanonicalJson.stringify(value)

/**
 * Stable reasons a cell failed to produce a transition.
 *
 * Every one of these is a durable observation the model may correct on a later
 * frame; none of them is a harness crash.
 *
 * `imports_forbidden` names module syntax the cell itself uses, which
 * `Sandbox.compile` finds by parsing. A quoted mention of an import is data:
 * cells routinely carry a `bash` command whose heredoc imports a Python module,
 * and those cells run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const RejectionCode = Schema.Literals([
  "no_cell",
  "imports_forbidden",
  "compile_failed",
  "invalid_transition",
  "unsupported_language",
  "limit_exceeded",
  "stalled"
])

/**
 * Stable reasons a cell failed to produce a transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RejectionCode = typeof RejectionCode.Type

/**
 * The cell ran and returned a well-formed transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Settled extends Schema.TaggedClass<Settled>("flows/harness/Cell/Settled")("settled", {
  transition: Transition
}) {}

/**
 * The cell ran and threw. The thrown value is projected into stable text so it
 * survives the journal and the next frame's context.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Raised extends Schema.TaggedClass<Raised>("flows/harness/Cell/Raised")("raised", {
  name: Schema.String,
  message: Schema.String
}) {}

/**
 * The cell never ran, or ran and returned something that is not a transition.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Rejected extends Schema.TaggedClass<Rejected>("flows/harness/Cell/Rejected")("rejected", {
  code: RejectionCode,
  message: Schema.String
}) {}

/**
 * Everything one cell evaluation may settle with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Outcome = Schema.Union([Settled, Raised, Rejected]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * Everything one cell evaluation may settle with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Outcome = typeof Outcome.Type

/**
 * The read-only projection of one callable flow handed to a cell.
 *
 * This is exactly what `ctx.flows` exposes: enough for the model to choose a
 * call and for the cell to reason about it, and nothing that carries authority.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class FlowProjection extends Schema.Class<FlowProjection>("flows/harness/Cell/FlowProjection")({
  name: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(Schema.String),
  tier: Descriptor.EffectTier,
  placement: Schema.Option(Descriptor.Placement),
  /**
   * The call's input schema, as a JSON Schema document, when the descriptor
   * carries one by value.
   *
   * Without it a cell can only guess an input shape from prose, and every
   * guess costs a whole frame: a rejected call is one model turn, so learning
   * `bash` takes `{ command, mode, reads, writes }` cost four turns of pure
   * trial and error before any work began.
   */
  input: Schema.Option(Schema.Json).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
    Schema.withDecodingDefaultKey(Effect.succeed(Option.none()))
  )
}) {}

/**
 * Projects a discovered descriptor into the cell-visible catalog entry.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const project = (descriptor: Descriptor.FlowDescriptor): FlowProjection =>
  new FlowProjection({
    name: descriptor.name,
    description: descriptor.description,
    capabilities: descriptor.capabilities,
    tier: descriptor.effects.tier,
    placement: descriptor.placement,
    input: descriptor.input._tag === "Inline" ? Option.some(descriptor.input.document) : Option.none()
  })

/**
 * Why one flow call failed, as a closed set a cell may branch on.
 *
 * Every member is a refusal or a budget the harness itself owns, plus one for
 * everything a flow reports about its own work. Add a member; never repurpose
 * one — a cell reads these, and so does a grader counting failure classes in a
 * journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const CallFailureCode = Schema.Literals([
  "unknown_flow",
  "capability_refused",
  "truncated_write",
  "declaration_changed",
  "invalid_input",
  "unimplemented",
  "timeout",
  "run_completed",
  "checkpoint_unavailable",
  "checkpoint_exhausted",
  "checkpoint_readonly",
  "checkpoint_unsupported",
  "flow_failed"
])

/**
 * Why one flow call failed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CallFailureCode = typeof CallFailureCode.Type

/**
 * The code a failure carries when nothing classified it.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultCallFailureCode: CallFailureCode = "flow_failed"

/**
 * The one action that recovers each failure class, stated to the cell.
 *
 * A code says what happened; the hint says what to do next, in the same frame.
 * They are here rather than at each raising site so the same class always reads
 * the same way whichever boundary refused.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const callFailureHint: Readonly<Record<CallFailureCode, string>> = Object.freeze({
  unknown_flow: "Read ctx.flows and call one of the names it lists.",
  capability_refused: "This run cannot reach that flow. Do the work with a flow ctx.flows lists.",
  truncated_write:
    "The bytes you passed were a fragment. Restore from source control instead of writing captured output.",
  declaration_changed: "Read ctx.flows again and reissue the call with the shape it now declares.",
  invalid_input: "Fix the input against the flow's declared schema in ctx.flows and call it again in this cell.",
  unimplemented: "This host cannot run that flow. Choose another one from ctx.flows.",
  timeout: "Narrow the call — a smaller root, a tighter pattern, a shorter command — and issue it again in this cell.",
  checkpoint_unavailable:
    "This host pins no checkpoint you can run against. Drop at and take the reading on the live tree.",
  checkpoint_exhausted: "Reuse a checkpoint you already hold, or ctx.base, instead of minting another one.",
  checkpoint_readonly:
    "A checkpoint is a read-only view of a tree that has already been. Drop at and make the change on the live tree.",
  checkpoint_unsupported:
    "This flow names what it touches rather than where it runs, so it cannot be pointed at a checkpoint. Drop at, or run the same work through a shell flow, which takes a working directory.",
  run_completed:
    "The run is over, so nothing after this line runs. If that was early, guard the ctx.done or ctx.park on the check that decides it.",
  flow_failed: "Read error.message: the flow itself says what went wrong, and it is usually fixable in this same cell."
})

/**
 * The complete identity of one flow call made inside one cell.
 *
 * Identity is what makes a mid-cell crash replayable. Re-executing the cell
 * source reaches the same lexical call in the same order with the same
 * declaration, so the boundary keys identically and replays; anything that
 * differs — a new frame, an edited cell, a different resolved layer set — keys
 * differently and executes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class CallIdentity extends Schema.Class<CallIdentity>("flows/harness/Cell/CallIdentity")({
  /** The durable session/lineage the frame belongs to. */
  session: Schema.String,
  /** The controller frame that produced the cell. */
  frame: NonNegativeSafeInt,
  /** The digest of the cell source being executed. */
  cell: Schema.String,
  /** The zero-based execution ordinal of this call within the cell. */
  ordinal: NonNegativeSafeInt,
  /** The digest of the resolved flow declaration being invoked. */
  declaration: Schema.String,
  /** The resolved layer set in effect at the boundary. */
  layers: Schema.Array(Schema.String)
}) {}

/**
 * Computes the declaration digest folded into a call identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declarationDigest = (descriptor: Descriptor.FlowDescriptor): string =>
  Digest.digest(
    CanonicalJson.stringify({
      name: descriptor.name,
      capabilities: [...descriptor.capabilities].sort(),
      effects: descriptor.effects,
      placement: Option.getOrNull(descriptor.placement),
      body: descriptor.body.path,
      provenance: { source: descriptor.provenance.source, root: descriptor.provenance.root }
    })
  )

/**
 * One flow call requested from inside a cell.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Call extends Schema.Class<Call>("flows/harness/Cell/Call")({
  flowName: Schema.String,
  input: Schema.Json,
  capabilities: Schema.Array(Schema.String),
  effects: Descriptor.EffectDeclaration,
  placement: Schema.Option(Descriptor.Placement),
  identity: CallIdentity,
  /**
   * The checkpoint this call runs against, when the cell named one.
   *
   * Absent is the ordinary case and means the live workspace. Present names a
   * tree the run already pinned, and the host materializes that tree somewhere
   * of its own choosing and runs the call there. It is journaled on the call
   * because it is the difference between a reading of the tree as it is and a
   * reading of the tree as it was, and a grader that cannot tell those apart
   * cannot grade a fails-before proof at all.
   */
  at: Schema.optional(Schema.String)
}) {}

/**
 * The id naming the tree a run opened on, pinned for free and always present.
 *
 * The dominant use of a checkpoint is a fails-before proof, and the frame that
 * wants one is almost never the frame that could have foreseen it: by the time
 * a run knows which command reproduces the bug it has usually already edited.
 * So this id exists without anybody minting it. A host resolves it to whatever
 * it recorded as the run's opening tree — for the SWE-bench rig, the
 * `refs/flows/capture-base` commit its own setup wrote — and a host with no
 * such record answers `checkpoint_unavailable` like any other.
 *
 * @category constants
 * @since 0.1.0
 */
export const baseCheckpoint = "base"

/**
 * The wire shape of the value `ctx.checkpoint()` resolves with.
 *
 * A handle is an opaque record rather than a bare string so a cell cannot pass
 * an arbitrary string as `at` by accident, and so a future host can carry more
 * beside the id without changing what a cell writes.
 */
const Handle = Schema.Struct({ checkpoint: Schema.NonEmptyString })

/**
 * Builds the handle a cell holds for one checkpoint.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpoint = (id: string): Schema.Json => ({ checkpoint: id })

/**
 * Reads the checkpoint id out of whatever a cell passed as `at`.
 *
 * `undefined` means "that was not a checkpoint", which the boundary answers as
 * an ordinary `invalid_input` failure rather than by guessing. It is
 * deliberately strict: a handle is the only thing that names a tree, and a
 * string that happens to look like an id would let a cell address a snapshot
 * the run never took.
 *
 * @category conversions
 * @since 0.1.0
 */
export const checkpointOf = (value: Schema.Json): string | undefined => {
  const decoded = Schema.decodeUnknownResult(Handle)(value)
  return decoded._tag === "Success" ? decoded.success.checkpoint : undefined
}

/**
 * The settled outcome of one flow call.
 *
 * A `failure` is data the cell may catch and recover from; it is never a
 * harness failure. Anything the cell cannot see — a permission park, an abort —
 * travels in the effect's error channel instead.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
  outcome: Schema.Literals(["success", "failure"]),
  value: Schema.Json,
  message: Schema.optional(Schema.String),
  /**
   * Why a failed call failed, from the closed set the cell may branch on.
   *
   * Prose is what a boundary says; a code is what a program reads. Without one
   * the only way for a cell to tell "that flow does not exist" from "that
   * command timed out" was to match the message, so cells did not tell them
   * apart at all. Absent means {@link defaultCallFailureCode}, which is what a
   * flow's own failure gets: the flow said why in `message` and the harness
   * does not classify it.
   */
  code: Schema.optional(CallFailureCode)
}) {}

/**
 * The failure envelope a cell observes when a flow call does not succeed.
 *
 * A failed call **resolves** with this value; it does not throw. That is the
 * whole of change 8: an unrecoverable rejection turned every failed call into a
 * lost frame, because the recovery branch the model had already written sat
 * behind the throw and never ran, and every sibling call the cell had already
 * paid for went with it. `psf__requests-2317` lost two settled greps and a
 * probe to one call against a directory that did not exist; `django-14351`
 * spent ~$0.46 on the same class across five frames.
 *
 * The shape is fixed and small — `{ ok: false, error: { code, message, hint } }`
 * — because a cell branches on `.ok` and reads `.error.code`. A successful call
 * still resolves with the flow's own value, unwrapped, so the ordinary
 * `result.stdout` shape a cell is trained on is unchanged.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const callFailure = (result: CallResult): Schema.Json => {
  const code = result.code ?? defaultCallFailureCode
  return {
    ok: false,
    error: {
      code,
      message: result.message ?? "The flow call failed",
      hint: callFailureHint[code]
    }
  }
}

const fenced = /```(?<info>[^\n`]*)\n(?<body>[\s\S]*?)\n?```/g

const languageOf = (info: string): Language | undefined => {
  const tokens = info.trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return undefined
  for (const token of tokens) {
    if (token === "cell" || token === "js" || token === "javascript") return "javascript"
    if (token === "ts" || token === "typescript") return "typescript"
  }
  return undefined
}

/**
 * One reply's cell program, and how many fenced blocks it was written in.
 *
 * `blocks` is journaled rather than derived later because it is the only
 * record of how the model chose to lay its frame out, and a reply written as
 * several blocks is exactly the reply the old extraction discarded.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Extracted {
  readonly source: Source
  /** How many fenced cell blocks the reply carried, repeats included. */
  readonly blocks: number
}

/**
 * Extracts the cell program one model settlement emitted.
 *
 * Every fenced block tagged as a cell is kept, in reply order, and the blocks
 * are joined with newlines into one program. They are bodies of one async
 * function, so the semantics that follows is the honest one and needs no
 * machinery: execution runs the blocks in order and the **first `return` wins**
 * — a block that settles a transition ends the frame and the blocks after it do
 * not run. That is how the model evidently thinks of them, as sequential
 * frames, and it is what a single concatenated function body already does.
 *
 * Keeping only the *last* block is what this replaces, and the cost of that
 * rule was measured: on one graded instance the model wrote a near-par program
 * as seven blocks in a single reply — recon, probe, edit-plus-diagnostics,
 * suite, rehydrate, guarded replay, completion — and the harness executed block
 * seven, the imagined completion, against a tree where blocks one through six
 * had never run. Empty patch, run over in two frames. Multi-block replies were
 * 2 of 91 replies in that wave: rare, and instance-deciding when they land.
 *
 * A byte-identical repeat of a block is dropped rather than concatenated. Both
 * multi-block replies in that wave are in the journals, and the second one is a
 * model that emitted the same block twice: joining the duplicate would declare
 * its names twice and turn a frame that runs today into a `compile_failed`. A
 * repeat is the model restating one program, never a second step — a second
 * step that genuinely re-runs the same code would still have to differ
 * somewhere, if only in what it does with the result.
 *
 * Distinct blocks are joined as they were written, so a value bound in one is
 * bound for the ones after it. One program therefore means one set of
 * declarations, and two blocks that both declare the same name are a
 * `SyntaxError` the compiler reports — a durable observation the next frame can
 * fix, unlike silently running one block of seven, which is not observable at
 * all. The contract states the rule so a model that batches writes blocks that
 * compose, and `CellTurn` names the block count when such a program fails to
 * compile.
 *
 * The program is `typescript` when any block declared a typed fence, because
 * both bindings run TypeScript by erasing type-only syntax and erasure is
 * harmless to a plain-JavaScript block.
 *
 * Extraction reads text and never judges syntax. Whether the source uses module
 * syntax is a question about JavaScript, and it is answered by parsing the cell
 * in `Sandbox.compile`, which is also where an `imports_forbidden` rejection is
 * raised.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const extract = (text: string): Result.Result<Extracted, Rejected> => {
  const bodies: Array<string> = []
  const distinct = new Set<string>()
  let typed = false
  fenced.lastIndex = 0
  for (const match of text.matchAll(fenced)) {
    /* v8 ignore next -- `info` is a mandatory group of `fenced`, outside any alternation or quantifier, so it participates in every match; the default only discharges the optional type TypeScript gives `RegExpMatchArray.groups` */
    const candidate = languageOf(match.groups?.info ?? "")
    if (candidate === undefined) continue
    if (candidate === "typescript") typed = true
    /* v8 ignore next -- `body` is likewise mandatory in `fenced`; a match that reached here already produced `info`, so `groups` is present and carries both */
    const body = match.groups?.body ?? ""
    bodies.push(body)
    distinct.add(body)
  }
  if (bodies.length === 0) {
    return Result.fail(
      new Rejected({
        code: "no_cell",
        message:
          "No cell was found in the response. Emit a fenced ```cell block containing the JavaScript for this transition."
      })
    )
  }
  return Result.succeed({
    source: source([...distinct].join("\n"), typed ? "typescript" : "javascript"),
    blocks: bodies.length
  })
}
