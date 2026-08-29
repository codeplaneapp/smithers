/**
 * Kanban pattern: move every item through an ordered list of columns, with a
 * concurrency bound applied inside each column.
 *
 * @see docs/reference/patterns-teams.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"
import * as Quarantine from "./Quarantine.ts"

/**
 * One card on the board.
 *
 * `id` is the identity a column call, a board row, and a failure entry all use,
 * so it must be unique across the declared items.
 *
 * @category models
 * @since 0.1.0
 */
export interface Item {
  readonly id: string
}

/**
 * One declared column.
 *
 * @category models
 * @since 0.1.0
 */
export interface Column {
  readonly name: string
  readonly flow: Flow.Any
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly columns: ReadonlyArray<Column>
  readonly items: ReadonlyArray<Item>
  readonly concurrency: number
  readonly onComplete?: Flow.Any | undefined
}

/**
 * One column at runtime.
 *
 * `previous` is the value the same item produced in the preceding column, and
 * is `undefined` in the first column.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeColumn<It extends Item, Out, E, R> {
  readonly name: string
  readonly run: (args: {
    readonly item: It
    readonly column: string
    readonly previous: Out | undefined
  }) => Effect.Effect<Out, E, R>
}

/**
 * One item that a column rejected.
 *
 * @category models
 * @since 0.1.0
 */
export interface Failure<E> {
  readonly id: string
  readonly column: string
  readonly error: E
}

/**
 * The state of the board after a pass.
 *
 * `board` holds one row per item that cleared at least one column, keyed by
 * item id then column name. `completed` lists the items that cleared every
 * column, in declaration order. `failed` lists the column that rejected an item
 * and the error it raised.
 *
 * @category models
 * @since 0.1.0
 */
export interface Board<Out, E> {
  readonly board: Record<string, Record<string, Out>>
  readonly completed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<Failure<E>>
  readonly iterations: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * `maxIterations` is the number of passes the board runs, and defaults to one.
 * `until` stops it early, after the pass whose result satisfies the predicate,
 * and requires `maxIterations`, because a predicate that never holds would
 * otherwise run forever.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<It extends Item, Out, E, R> {
  readonly columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>
  readonly concurrency: number
  readonly until?: ((board: Board<Out, E>) => boolean) | undefined
  readonly maxIterations?: number | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const merge = (left: unknown, right: unknown): Record<string, unknown> => ({
  ...(left as Record<string, unknown>),
  ...(right as Record<string, unknown>)
})

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/**
 * Builds the board topology: for each column in order, one call per item,
 * batched into `Node.all` groups of `concurrency` members, with the batches
 * sequenced so the plan never admits more parallel calls than the bound.
 *
 * Each call receives `{ column, item, previous }`. `previous` refers to the
 * same item's result in the preceding column, so a built graph shows the
 * per-item chain across columns rather than a column-wide barrier of values.
 * The columns themselves are sequenced: a column's first call depends on the
 * whole preceding column.
 *
 * `make` throws a `PatternError` when there are no columns, no items, a
 * duplicate item id, or a concurrency that is not a positive safe integer.
 *
 * A column joins its batch with {@link Quarantine.all} under the `quarantine`
 * policy, because one rejected card is not a reason to interrupt the cards
 * beside it — which is the same call {@link run} makes. A rejected card
 * settles as a {@link Quarantine.Quarantined} marker naming the item.
 *
 * The declaration does not drop a quarantined card from the later columns: a
 * plan has no branch, so the card travels on with its marker as `previous` and
 * the column flow decides what a quarantined predecessor means. `run` has the
 * value in hand and does drop it, so a board's declared call count is an upper
 * bound on the calls a pass makes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (options.columns.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" })
  }
  if (options.items.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one item" })
  }
  if (!bound(options.concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Kanban concurrency must be a positive safe integer"
    })
  }
  const ids = options.items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" })
  }
  const names = options.columns.map((column) => column.name)
  const captures = { columns: names, items: ids, concurrency: options.concurrency }
  const column = (index: number, previous: unknown): Node.Node<unknown, unknown> => {
    const declared = options.columns[index]!
    const batchAt = (offset: number): Node.Node<unknown, unknown> => {
      const members: Record<string, Node.Any> = {}
      for (const item of options.items.slice(offset, offset + options.concurrency)) {
        members[item.id] = call(declared.flow, {
          column: declared.name,
          item,
          previous: previous === undefined ? undefined : (previous as Record<string, unknown>)[item.id]
        })
      }
      return Quarantine.all(members, { policy: "quarantine" })
    }
    let batches = batchAt(0)
    for (let offset = options.concurrency; offset < options.items.length; offset += options.concurrency) {
      const batch = batchAt(offset)
      batches = Node.andThen(
        batches,
        Node.capture({ column: declared.name, offset }, (soFar) =>
          Node.map(
            batch,
            Node.capture({ column: declared.name, offset }, (values) => merge(soFar, values))
          ))
      )
    }
    return batches
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: options.onComplete === undefined
      ? options.columns.map((declared) => declared.flow)
      : [...options.columns.map((declared) => declared.flow), options.onComplete],
    body: Node.capture(captures, () => {
      const walk = (index: number, previous: unknown): Node.Node<unknown, unknown> => {
        const current = column(index, previous)
        if (index + 1 < options.columns.length) {
          return Node.andThen(
            current,
            Node.capture({ ...captures, column: names[index + 1] }, (values) => walk(index + 1, values))
          )
        }
        const complete = options.onComplete
        if (complete === undefined) return current
        return Node.andThen(
          current,
          Node.capture(captures, (values) => call(complete, { phase: "complete", items: options.items, board: values }))
        )
      }
      return walk(0, undefined)
    })
  })
}

const pass = <It extends Item, Out, E, R>(
  items: ReadonlyArray<It>,
  options: RuntimeOptions<It, Out, E, R>
): Effect.Effect<Omit<Board<Out, E>, "iterations">, never, R> =>
  Effect.gen(function*() {
    const board: Record<string, Record<string, Out>> = {}
    const failed: Array<Failure<E>> = []
    const latest = new Map<string, Out>()
    let active: ReadonlyArray<It> = items
    for (const column of options.columns) {
      const outcomes = yield* Effect.forEach(
        active,
        (item) =>
          column.run({ item, column: column.name, previous: latest.get(item.id) }).pipe(
            Effect.map((output) => ({ ok: true, item, output } as const)),
            Effect.catch((error: E) => Effect.succeed({ ok: false, item, error } as const))
          ),
        { concurrency: options.concurrency }
      )
      const next: Array<It> = []
      for (const outcome of outcomes) {
        if (outcome.ok) {
          board[outcome.item.id] = { ...board[outcome.item.id], [column.name]: outcome.output }
          latest.set(outcome.item.id, outcome.output)
          next.push(outcome.item)
        } else {
          failed.push({ id: outcome.item.id, column: column.name, error: outcome.error })
        }
      }
      active = next
    }
    return { board, completed: active.map((item) => item.id), failed }
  })

/**
 * Moves every item through the columns in order.
 *
 * A column runs its items with `Effect.forEach` at `concurrency`, so at most
 * `concurrency` items are in flight in that column, and a column starts only
 * after the preceding column has settled for every item. An item a column
 * rejects is dropped from the board and listed in `failed`; the other items
 * keep moving.
 *
 * The board runs `maxIterations` passes over the same items, one when the
 * option is absent. The old `<Kanban>` component defaulted that bound to five,
 * so a port that relied on the default must pass `maxIterations: 5`. `until`
 * stops the board early after the pass whose result satisfies the predicate. Each pass starts from an empty board, and the
 * returned board is the last pass's.
 *
 * `run` fails with a `PatternError` when two items share an id: the board is
 * keyed by item id, so a repeated id would run the same id twice and report
 * one row for both.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <It extends Item, Out, E = never, R = never>(
  items: ReadonlyArray<It>,
  options: RuntimeOptions<It, Out, E, R>
): Effect.Effect<Board<Out, E>, PatternError, R> => {
  if (options.columns.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" }))
  }
  if (!bound(options.concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban concurrency must be a positive safe integer"
      })
    )
  }
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" }))
  }
  const maxIterations = options.maxIterations
  if (options.until !== undefined && maxIterations === undefined) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban until requires maxIterations"
      })
    )
  }
  if (maxIterations !== undefined && !bound(maxIterations)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban maxIterations must be a positive safe integer"
      })
    )
  }
  const limit = maxIterations ?? 1
  return Effect.gen(function*() {
    let iterations = 0
    for (;;) {
      const settled = yield* pass(items, options)
      iterations += 1
      const result: Board<Out, E> = { ...settled, iterations }
      if (iterations >= limit) return result
      if (options.until !== undefined && options.until(result)) return result
    }
  })
}
