/** The implementation leaf uses the same agent and native JJ actions as any flow. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { ApplyNative, NativeCoding, NativeCodingError, Operation, OperationResult, requestIdFor } from "./native.ts"
import { AtomicPlan, Change, CodingError, Implementation, Revision } from "./schema.ts"

const Error = Schema.Union([CodingError, NativeCodingError, AgentAction.AgentFailure])
const EditReport = Schema.Struct({ summary: Schema.NonEmptyString, reads: Schema.Array(Schema.String), writes: Schema.Array(Schema.String) })
const Entry = Action.make("coding/prepare-atom", {
  payload: { atom: AtomicPlan, parent: Revision, ordinal: Schema.Number },
  success: Operation, error: Error, nondeterministic: true
})
const Prepare = Action.make("coding/prepare-atom-mutation", {
  // The recorded edit report is also the graph dependency: file capture cannot
  // be prepared until the agent has finished writing this atom.
  payload: { phase: Schema.Literals(["snapshot", "describe"]), atom: AtomicPlan, revision: Revision, parent: Revision, ordinal: Schema.Number, editing: EditReport },
  success: Operation, error: Error, nondeterministic: true
})
const Observe = Action.make("coding/observe-atom", {
  payload: { result: OperationResult, parent: Revision, expectedChangeId: Schema.NullOr(Schema.String) },
  success: Revision, error: CodingError
})

/** The host supplies its existing tool bindings, seats, capabilities and budget. */
export const EditAtom = AgentAction.make("coding/edit-atom", {
  payload: { atom: AtomicPlan, parent: Revision, revision: Revision, memoryRevision: Schema.String },
  output: EditReport,
  seat: "coding/implement",
  system: [
    "Implement the single atomic change in the owning workspace using the provided filesystem tools.",
    "The workflow owns JJ operations: do not invoke JJ, Git, create commits, or switch workspaces.",
    "Follow repository instructions. Keep the change small and confined to its intent. Report actual files read and written.",
    "The workflow runs independent checks. Your summary is an explanation of your work, never a passing check receipt."
  ],
  prompt: input => JSON.stringify(input)
})

const stale = (message: string) => new CodingError({ code: "stale_revision", message })
/** Operation IDs are read-view identities; exact commit/tree/parents identify unchanged code. */
const sameCode = (left: Revision, right: Revision) =>
  left.changeId === right.changeId && left.commitId === right.commitId && left.treeId === right.treeId &&
  left.parentCommitIds.length === right.parentCommitIds.length && left.parentCommitIds.every((id, i) => id === right.parentCommitIds[i])

const readParent = (parent: Revision, changeId?: string) => Effect.gen(function*() {
  const native = yield* NativeCoding
  const read = yield* native.read([...new Set([parent.changeId, ...(changeId ? [changeId] : [])])])
  const currentParent = read.revisions.find(value => value.changeId === parent.changeId)
  if (!currentParent || currentParent.kind !== "resolved" || !sameCode(currentParent, parent)) {
    return yield* stale("The atom's parent changed; replan before editing its files")
  }
  return { read, parent: currentParent }
})

/** Prepared requests are journaled separately, so a lost native acknowledgement replays the original request. */
export const atomOperations = Layer.mergeAll(
  Entry.toLayer(({ atom, parent, ordinal }) => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const current = yield* readParent(parent, atom.changeId ?? undefined)
    const requestId = requestIdFor(instance.executionId, `atom/${ordinal}/enter`)
    if (atom.changeId === null) return {
      operation: "create" as const, requestId, expectedOperationId: current.read.operationId,
      target: current.parent, description: atom.message
    }
    const target = current.read.revisions.find(value => value.changeId === atom.changeId)
    if (!target || target.kind !== "resolved" || target.parentCommitIds.length !== 1 || target.parentCommitIds[0] !== parent.commitId) {
      return yield* stale("The existing JJ atom is not the next change after its planned parent")
    }
    return { operation: "edit" as const, requestId, expectedOperationId: current.read.operationId, target }
  })),
  Prepare.toLayer(({ phase, atom, revision, parent, ordinal }) => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const current = yield* readParent(parent, revision.changeId)
    const target = current.read.head
    if (target.kind !== "resolved" || target.changeId !== revision.changeId ||
        target.parentCommitIds.length !== 1 || target.parentCommitIds[0] !== parent.commitId ||
        (phase === "describe" && !sameCode(target, revision))) {
      return yield* stale("The owning working copy or atom ancestry changed during implementation")
    }
    // The existing head reporter may have captured the agent's file edits.
    // Snapshot accepts that same native change, but never a different parent.
    const expected = { requestId: requestIdFor(instance.executionId, `atom/${ordinal}/${phase}`), expectedOperationId: current.read.operationId, target }
    return phase === "snapshot" ? { ...expected, operation: "snapshot" as const }
      : { ...expected, operation: "describe" as const, description: atom.message }
  })),
  Observe.toLayer(({ result, parent, expectedChangeId }) => Effect.gen(function*() {
    const revision = result.revision
    if (revision.kind !== "resolved" || revision.parentCommitIds.length !== 1 || revision.parentCommitIds[0] !== parent.commitId ||
        revision.changeId === parent.changeId || (expectedChangeId !== null && revision.changeId !== expectedChangeId) ||
        (expectedChangeId === null && result.status !== "accepted")) {
      return yield* stale("Native JJ returned a conflicted, replaced, or differently parented atom")
    }
    return revision
  }))
)

const Atom = Flow.make("coding/ImplementAtom", {
  payload: { atom: AtomicPlan, parent: Revision, ordinal: Schema.Number, memoryRevision: Schema.String },
  success: Schema.Struct({ revision: Revision, reads: Schema.Array(Schema.String), writes: Schema.Array(Schema.String) }),
  error: Error,
  body: ({ atom, parent, ordinal, memoryRevision }) => Entry.call({ atom, parent, ordinal }).pipe(
    Node.bindPlanned(operation => ApplyNative.call({ operation })),
    Node.bindPlanned(result => Observe.call({ result, parent, expectedChangeId: atom.changeId })),
    Node.bindPlanned(revision => EditAtom.call({ atom, parent, revision, memoryRevision }).pipe(
      Node.bindPlanned(report => Node.all({ report: Node.succeed(report), final: Prepare.call({ phase: "snapshot", atom, revision, parent, ordinal, editing: report }).pipe(
        Node.bindPlanned(operation => ApplyNative.call({ operation })),
        Node.bindPlanned(result => Observe.call({ result, parent, expectedChangeId: revision.changeId })),
        Node.bindPlanned(snapshot => Prepare.call({ phase: "describe", atom, revision: snapshot, parent, ordinal, editing: report })),
        Node.bindPlanned(operation => ApplyNative.call({ operation })),
        Node.bindPlanned(result => Observe.call({ result, parent, expectedChangeId: revision.changeId }))
      ) }).pipe(Node.map(({ report, final }) => ({ revision: final, reads: report.reads, writes: report.writes }))))
    ))
  )
})

type AtomResult = typeof Atom.successSchema.Type
type AtomsNode = Node.Node<ReadonlyArray<AtomResult>, typeof Error.Type, Node.Services<ReturnType<typeof Atom.call>>>
const atoms = (change: typeof Change.Type, parent: Parameters<typeof Atom.call>[0]["parent"], memoryRevision: string, ordinal: number): AtomsNode => {
  const atom = change.atoms[ordinal]
  return atom === undefined ? Node.succeed([]) : Atom.call({ atom, parent, memoryRevision, ordinal }).pipe(
    Node.bindPlanned(result => Node.all({ current: Node.succeed(result), rest: atoms(change, result.revision, memoryRevision, ordinal + 1) })
      .pipe(Node.map(({ current, rest }) => [current, ...rest])))
  )
}

/** A project implementation delegate can call this flow and return its native evidence. */
export const ImplementAtoms = Flow.make("coding/ImplementAtoms", {
  payload: { change: Change, parent: Revision, memoryRevision: Schema.NonEmptyString },
  success: Implementation, error: Error,
  body: ({ change, parent, memoryRevision }) => atoms(change, parent, memoryRevision, 0).pipe(Node.map(results => ({
    change: change.id, parent, atoms: results.map(result => result.revision), head: results.at(-1)!.revision,
    reads: [...new Set(results.flatMap(result => result.reads))], writes: [...new Set(results.flatMap(result => result.writes))]
  })))
})

const Refuse = Action.make("coding/refuse-atom-input", { payload: {}, success: Implementation, error: CodingError })

/** Existing registry Invocation envelope, consumed by the configured catalog. */
export const atomDelegate = Flow.make("coding/Implement", {
  payload: Executable.Invocation, success: Implementation, error: Error,
  body: ({ input }): Node.Node<Implementation, typeof Error.Type,
    Node.Services<ReturnType<typeof ImplementAtoms.call>> | Action.Requirement<typeof Refuse.name>> => {
    const decoded = Schema.decodeUnknownOption(ImplementAtoms.payloadSchema)(input)
    return Option.isSome(decoded) ? ImplementAtoms.call(decoded.value) : Refuse.call({})
  }
})

export const atomFlows = Layer.mergeAll(
  Interpreter.layer(Atom), Interpreter.layer(ImplementAtoms), Interpreter.layer(atomDelegate),
  Refuse.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "Implementation input must identify its Change, exact parent and memory revision" })))
)
