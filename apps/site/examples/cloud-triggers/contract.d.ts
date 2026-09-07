/**
 * Declaration-only contract for the Cloud trigger documentation.
 * These signatures describe the feature being authored; they supply no runtime.
 */
import type * as Schema from "effect/Schema"

export type NonEmpty<A> = readonly [A, ...A[]]
export type Filter = NonEmpty<string> | (
  | { readonly include: NonEmpty<string>; readonly exclude?: NonEmpty<string> }
  | { readonly include?: NonEmpty<string>; readonly exclude: NonEmpty<string> }
)

export interface EventBase {
  readonly type: string
  readonly id: string
  readonly repository: { readonly id: string; readonly host: "plue" | "github" }
  readonly receivedAt: string
}

export interface PushEvent extends EventBase {
  readonly type: "push"
  readonly branch: string
  readonly commit: string
  readonly before: string | null
}

export type ReviewAction = "opened" | "reopened" | "updated" | "ready" | "labeled" | "closed" | "merged"
export type DefaultReviewAction = "opened" | "reopened" | "updated" | "ready"
export type ReviewEvent<A extends ReviewAction = ReviewAction> = A extends ReviewAction ? EventBase & {
  readonly type: "review"
  readonly action: A
  readonly review: {
    readonly number: number
    readonly base: string
    readonly head: string
    readonly headCommit: string
    readonly baseCommit: string
    readonly draft: boolean
  }
} & (A extends "labeled" ? { readonly label: string } : {}) : never

export interface TagEvent extends EventBase {
  readonly type: "tag"
  readonly name: string
  readonly commit: string
}

export interface ScheduleEvent extends EventBase {
  readonly type: "schedule"
  readonly scheduledAt: string
  readonly timezone: string
}

declare const triggerBrand: unique symbol
export interface Selector<E extends EventBase> {
  readonly [triggerBrand]: E
}
export type AnyTrigger = Selector<EventBase>
export type EventOf<T> = T extends Selector<infer E> ? E : never
export type Events<T extends NonEmpty<AnyTrigger>> = EventOf<T[number]>

export type InputSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

declare const automationBrand: unique symbol
export interface Automation<E extends EventBase, O> {
  readonly [automationBrand]: { readonly event: E; readonly output: O }
}
type CauseOf<A> = A extends Automation<infer E, unknown> ? E : never
type OutputOf<A> = A extends Automation<EventBase, infer O> ? O : never

export declare const T: {
  readonly push: (options?: { readonly branches?: Filter; readonly paths?: Filter }) => Selector<PushEvent>
  readonly review: <const A extends NonEmpty<ReviewAction> = readonly ["opened", "reopened", "updated", "ready"]>(
    options?: {
      readonly actions?: A
      readonly base?: Filter
      readonly head?: Filter
      readonly paths?: Filter
      readonly drafts?: boolean
    }
  ) => Selector<ReviewEvent<A[number]>>
  readonly tag: (options?: { readonly names?: Filter }) => Selector<TagEvent>
  readonly schedule: (options: {
    readonly cron: string
    readonly timezone?: string
    readonly ref?: string
  }) => Selector<ScheduleEvent>
  readonly manual: {
    (): Selector<EventBase & { readonly type: "manual"; readonly input: Readonly<Record<string, never>> }>
    <S extends InputSchema>(options: { readonly input: S }): Selector<EventBase & {
      readonly type: "manual"
      readonly input: S["Type"]
    }>
  }
  readonly event: <const N extends string, S extends InputSchema>(options: {
    readonly name: N
    readonly input: S
  }) => Selector<EventBase & { readonly type: "event"; readonly name: N; readonly input: S["Type"] }>
  readonly succeeded: <A extends Automation<EventBase, unknown>>(automation: A) => Selector<EventBase & {
    readonly type: "succeeded"
    readonly runId: string
    readonly commit: string
    readonly cause: CauseOf<A>
    readonly output: OutputOf<A>
  }>
}

declare const targetBrand: unique symbol
export interface Target {
  readonly [targetBrand]: true
}

/** The schema-bearing portion of the existing @smthrs/flow Flow contract. */
export interface FlowRef {
  readonly _tag: string
  readonly payloadSchema: InputSchema
  readonly successSchema: InputSchema
}

type InputOf<F extends FlowRef> = F["payloadSchema"]["~type.make.in"]
type ResultOf<R> = R extends FlowRef ? R["successSchema"]["Type"] : {
  readonly targets: ReadonlyArray<{ readonly label: string; readonly status: "ran" | "hit" }>
}

type Mapping<R, E> = R extends FlowRef
  ? {} extends InputOf<R>
    ? { readonly input?: (event: E) => InputOf<R> }
    : { readonly input: (event: E) => InputOf<R> }
  : { readonly input?: never }

export declare const S: {
  readonly Automation: <const TS extends NonEmpty<AnyTrigger>, R extends Target | FlowRef>(options: {
    readonly on: TS
    readonly run: R
    readonly when?: (event: Events<NoInfer<TS>>) => boolean
  } & Mapping<NoInfer<R>, Events<NoInfer<TS>>>) => Automation<Events<TS>, ResultOf<R>>
  readonly Package: <
    const Targets extends Readonly<Record<string, Target>> = {},
    const Automations extends Readonly<Record<string, Automation<EventBase, unknown>>> = {}
  >(options: {
    readonly targets?: Targets
    readonly automations?: Automations
  }) => Targets & { readonly automations: Automations }
}
