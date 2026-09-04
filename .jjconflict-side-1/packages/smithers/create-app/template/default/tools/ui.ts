/**
 * The UI tool: two bindings that put a card in the transcript.
 *
 * `ui/pane` renders a pane the app registered by file location
 * (`app/panes/<name>.tsx`); `ui/html` renders a block of HTML the model wrote
 * itself. Both return only a `cardId`, because the card itself travels to the
 * browser on the turn stream rather than through the cell's return value.
 *
 * Neither binding renders anything. They hand the card to the {@link CardSink}
 * the host provides for the turn. The source `TOOLS.ts` composes uses
 * {@link makeCollecting} over a module-level array, which is a working mock: a
 * real host builds its own with `uiSource` so cards reach the session.
 */
import * as Flow from "@smthrs/core/Flow"
import type { AppCard } from "@smthrs/create-app/ui"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The one failure a UI call reports to a cell. `FlowBinding.make` renders it as
 * a catchable result, so the message is written for the model: it names what
 * was wrong and what to do next.
 */
export class UiError extends Schema.TaggedError<UiError>()("app/tools/UiError", {
  message: Schema.String
}) {}

/** Where a rendered card goes. A host binds one per turn. */
export interface CardSinkService {
  readonly emit: (card: AppCard) => Effect.Effect<void>
  readonly update: (card: AppCard) => Effect.Effect<void>
}

/** Service tag for the turn's card sink. */
export class CardSink extends Context.Service<CardSink, CardSinkService>()("app/tools/CardSink") {}

/** A sink that appends every card to `collected`, in emission order. */
export const makeCollecting = (collected: Array<AppCard>): CardSinkService =>
  CardSink.of({
    emit: (card) => Effect.sync(() => void collected.push(card)),
    update: (card) =>
      Effect.sync(() => {
        const index = collected.findIndex((entry) => entry.id === card.id)
        if (index === -1) collected.push(card)
        else collected[index] = card
      })
  })

/** One registered pane. `fullscreen` rides along because the card carries it. */
export interface RegisteredPane {
  readonly name: string
  readonly fullscreen: boolean
}

/** The panes this app routed. */
export interface PaneNamesService {
  readonly list: () => Effect.Effect<ReadonlyArray<RegisteredPane>>
}

/** Service tag for the registered pane list. */
export class PaneNames extends Context.Service<PaneNames, PaneNamesService>()("app/tools/PaneNames") {}

/** A registry over a fixed pane list. */
export const makePanes = (panes: ReadonlyArray<RegisteredPane>): PaneNamesService =>
  PaneNames.of({ list: () => Effect.succeed(panes) })

export const PaneInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Registered pane name, as listed in the failure message when wrong" }),
  props: Schema.Unknown.annotate({ description: "Props object the pane's own schema decodes" }),
  title: Schema.optionalKey(
    Schema.String.annotate({ description: "Card heading; the pane's own title is used when omitted" })
  )
})

export const PaneOutput = Schema.Struct({
  cardId: Schema.String.annotate({ description: "Id of the emitted card; pass it back to update the same card" })
})

export const HtmlInput = Schema.Struct({
  html: Schema.String.annotate({ description: "HTML fragment; the shell sanitizes it before rendering" }),
  title: Schema.optionalKey(Schema.String.annotate({ description: "Card heading" }))
})

const paneFlow = Flow.make({
  name: "ui/pane",
  description:
    "Render a registered pane as a card in the transcript. Prefer this over prose whenever a pane fits the data; a wrong name is refused with the list of registered panes.",
  input: PaneInput,
  output: PaneOutput,
  capabilities: [],
  effects: undefined
})

const htmlFlow = Flow.make({
  name: "ui/html",
  description:
    "Render an HTML fragment as a card in the transcript. Use it only when no registered pane fits; a pane is always the better answer.",
  input: HtmlInput,
  output: PaneOutput,
  capabilities: [],
  effects: undefined
})

/**
 * A card id that survives a replay.
 *
 * The cell re-executes from the top after a crash or a permission park, so a
 * random id would emit a second card for the same call. The frame and the
 * call's ordinal within its cell are exactly the pair that does not move.
 */
const cardIdOf = (frame: number, ordinal: number): string => `card-${frame}-${ordinal}`

const unknownPane = (name: string, panes: ReadonlyArray<RegisteredPane>): UiError =>
  new UiError({
    message: panes.length === 0
      ? `No panes are registered in this app, so "${name}" cannot be rendered. Answer in prose, or call ui/html.`
      : `"${name}" is not a registered pane. Registered panes: ${
        panes.map((pane) => pane.name).join(", ")
      }. Reissue ui/pane with one of those names.`
  })

/** The UI flows, bound to the sink and pane registry a host built. */
export const uiSource = (services: Context.Context<CardSink | PaneNames>): FlowBinding.Source =>
  FlowBinding.source("ui", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: paneFlow,
        handler: (input, call) =>
          Effect.gen(function*() {
            const registry = yield* PaneNames
            const panes = yield* registry.list()
            const pane = panes.find((entry) => entry.name === input.name)
            if (pane === undefined) return yield* Effect.fail(unknownPane(input.name, panes))
            const sink = yield* CardSink
            const cardId = cardIdOf(call.identity.frame, call.identity.ordinal)
            yield* sink.emit({
              kind: "pane",
              id: cardId,
              name: pane.name,
              props: input.props,
              fullscreen: pane.fullscreen,
              ...(input.title === undefined ? {} : { title: input.title })
            })
            return { cardId }
          })
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: htmlFlow,
        handler: (input, call) =>
          Effect.gen(function*() {
            const sink = yield* CardSink
            const cardId = cardIdOf(call.identity.frame, call.identity.ordinal)
            yield* sink.emit({
              kind: "html",
              id: cardId,
              html: input.html,
              ...(input.title === undefined ? {} : { title: input.title })
            })
            return { cardId }
          })
      }),
      services
    )
  ])

/** Cards the mock sink collected, newest last. A host replaces this wholesale. */
export const collectedCards: Array<AppCard> = []

/**
 * The source `TOOLS.ts` composes: a collecting sink and the one pane this
 * template ships. Keep the pane list in step with `app/panes/`, or replace this
 * with a host-built source that reads `paneNames` from `routes.gen.ts`.
 */
export const ui: FlowBinding.Source = uiSource(
  Context.add(
    Context.make(CardSink, makeCollecting(collectedCards)),
    PaneNames,
    makePanes([{ name: "message", fullscreen: false }])
  )
)
