import * as Schema from "effect/Schema"
import { S, T, type EventOf, type Target } from "./contract.js"

declare const prePush: Target
const ci = S.Automation({
  on: [T.push({ branches: ["main"] }), T.review({ base: ["main"] })],
  run: prePush,
  when: event => {
    if (event.type === "push") return event.branch === "main"
    const action: "opened" | "reopened" | "updated" | "ready" = event.action
    // @ts-expect-error Push fields are not present on a review event.
    event.branch
    return event.review.base === "main" && action !== "ready"
  },
})
S.Package({ targets: { prePush }, automations: { ci } })

T.review({ actions: ["labeled"], base: { include: ["main"], exclude: ["release/**"] } })
T.tag({ names: ["v*"] })
T.schedule({ cron: "0 9 * * 1-5", timezone: "America/New_York", ref: "main" })

// @ts-expect-error Push events have no review activity filter.
T.push({ actions: ["opened"] })
// @ts-expect-error Invalid activity name.
T.review({ actions: ["synchronize"] })
// @ts-expect-error Use base or head, not an ambiguous branches filter.
T.review({ branches: ["main"] })
// @ts-expect-error Schedules have one ref, not branch filters.
T.schedule({ cron: "0 9 * * *", branches: ["main"] })
// @ts-expect-error Empty match lists are invalid.
T.push({ branches: [] })
// @ts-expect-error Empty filter objects are invalid.
T.push({ paths: {} })
// @ts-expect-error A binding needs at least one explicit trigger.
S.Automation({ on: [], run: prePush })
// @ts-expect-error Targets do not consume a flow input mapper.
S.Automation({ on: [T.push()], run: prePush, input: () => ({}) })
// @ts-expect-error Predicates are synchronous.
S.Automation({ on: [T.push()], run: prePush, when: async () => true })

const DeployInput = Schema.Struct({
  environment: Schema.Literals(["staging", "production"]),
  version: Schema.String,
})
const DeployOutput = Schema.Struct({ url: Schema.String })
declare const Deploy: {
  readonly _tag: "app/Deploy"
  readonly payloadSchema: typeof DeployInput
  readonly successSchema: typeof DeployOutput
}

const deploy = S.Automation({
  on: [T.manual({ input: Deploy.payloadSchema })],
  run: Deploy,
  input: event => {
    const environment: "staging" | "production" = event.input.environment
    // @ts-expect-error The inferred payload has no revision field.
    event.input.revision
    return { environment, version: event.input.version }
  },
})

// @ts-expect-error The required flow payload must be mapped explicitly.
S.Automation({ on: [T.manual()], run: Deploy })
S.Automation({ on: [T.manual()], run: Deploy,
  // @ts-expect-error Missing required version cannot widen the destination flow.
  input: () => ({ environment: "staging" }),
})
S.Automation({ on: [T.manual()], run: Deploy,
  // @ts-expect-error A value outside the flow's schema is rejected.
  input: () => ({ environment: "dev", version: "1.0.0" }),
})
S.Automation({ on: [T.manual()], run: Deploy,
  // @ts-expect-error Asynchronous mapping cannot satisfy the payload type.
  input: async () => ({ environment: "staging", version: "1.0.0" }),
})

const requested = T.event({ name: "deploy.requested", input: DeployInput })
const failed = T.event({ name: "deploy.failed", input: Schema.Struct({ reason: Schema.String }) })
S.Automation({
  on: [requested, failed],
  run: prePush,
  when: event => {
    if (event.name === "deploy.requested") {
      const version: string = event.input.version
      return version.length > 0
    }
    const reason: string = event.input.reason
    // @ts-expect-error The literal event name narrows the payload.
    event.input.version
    return reason.length > 0
  },
})
// @ts-expect-error External input needs a runtime schema.
T.event({ name: "deploy.requested" })

S.Automation({
  on: [T.review({ actions: ["labeled", "updated"] })],
  run: prePush,
  when: event => {
    if (event.action === "labeled") return event.label === "ready"
    // @ts-expect-error Only a labeled event carries a label.
    event.label
    return true
  },
})

S.Automation({
  on: [T.succeeded(deploy)],
  run: prePush,
  when: event => {
    const url: string = event.output.url
    const environment: "staging" | "production" = event.cause.input.environment
    // @ts-expect-error Completion preserves the upstream output schema.
    event.output.artifact
    return environment === "production" && url.startsWith("https:")
  },
})

// A runtime codec keeps decoded event data separate from encoded transport data.
const DatedInput = Schema.Struct({ at: Schema.DateFromString })
const dated = T.manual({ input: DatedInput })
declare const datedEvent: EventOf<typeof dated>
const decodedDate: Date = datedEvent.input.at
// @ts-expect-error Ingress has already decoded the ISO string.
const encodedDate: string = datedEvent.input.at
declare const DateFlow: {
  readonly _tag: "app/Dated"
  readonly payloadSchema: typeof DatedInput
  readonly successSchema: typeof DeployOutput
}
S.Automation({ on: [dated], run: DateFlow, input: event => ({ at: event.input.at }) })

const EmptyInput = Schema.Struct({})
declare const EmptyFlow: {
  readonly _tag: "app/Empty"
  readonly payloadSchema: typeof EmptyInput
  readonly successSchema: typeof DeployOutput
}
S.Automation({ on: [T.schedule({ cron: "0 3 * * *" })], run: EmptyFlow })
void decodedDate
void encodedDate
