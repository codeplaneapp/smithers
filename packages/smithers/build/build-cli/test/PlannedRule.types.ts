import type * as Agent from "@smthrs/targets/AgentTarget"
import type * as Rule from "../src/internal/RuleContract.ts"
import { contract } from "../src/internal/rules/FetchRule.ts"

// Compiled by tsconfig.test.json. Each negative starts with an otherwise valid
// node so the expected error witnesses the stated invariant.
declare const fetch: Rule.Planned<Rule.Fetch>
declare const process: Extract<Rule.PlannedRule, { family: "process" }>
declare const stamp: Extract<Rule.PlannedRule, { family: "stamp" }>
declare const service: Extract<Rule.PlannedRule, { rule: "Shell.Serve" }>
declare const agent: Extract<Rule.PlannedRule, { rule: "Agent.Lint" }>
declare const diff: Agent.DiffPayload
declare const refused: Rule.SharedFields & Rule.Refused
declare const input: Rule.SharedFields["declaredInputs"][number]
declare const accept: (node: Rule.PlannedRule) => void

accept(fetch)
accept(process)
accept(stamp)
accept(service)
accept(agent)
accept(refused)
contract.execute(fetch, { root: "/workspace", signal: undefined })

// @ts-expect-error A Fetch executor cannot consume the stamp variant.
contract.execute(stamp, { root: "/workspace", signal: undefined })
// @ts-expect-error The native rule name cannot be paired with another family.
accept({ ...fetch, rule: "Docs.Check" })
// @ts-expect-error Fetch requires the resolved URL and digest lane.
accept({ ...fetch, lane: undefined })
// @ts-expect-error Fetch's digest is required.
accept({ ...fetch, lane: { kind: "fetch", url: "https://example.invalid/a" } })
// @ts-expect-error Fetch declares exactly one file.
accept({ ...fetch, outFiles: [] })
// @ts-expect-error Fetch cannot produce two files.
accept({ ...fetch, outFiles: ["a", "b"] })
// @ts-expect-error Fetch requires its declared output boundary.
accept({ ...fetch, declaredOutputs: undefined })
// @ts-expect-error Fetch's declaration names exactly one output.
accept({ ...fetch, declaredOutputs: { cwd: ".", paths: [] } })
// @ts-expect-error Fetch does not acquire services.
accept({ ...fetch, serviceDeps: ["//app:server"] })
// @ts-expect-error Fetch's URL and digest are its inputs, not declared files.
accept({ ...fetch, declaredInputs: [input] })
// @ts-expect-error Fetch is an execute rule.
accept({ ...fetch, mode: "check" })
// @ts-expect-error Fetch cannot disable its intrinsic network policy.
accept({ ...fetch, sandbox: "none" })
// @ts-expect-error Fetch does not spawn commands.
accept({ ...fetch, argv: ["curl"] })
// @ts-expect-error Fetch cannot declare directory outputs.
accept({ ...fetch, outDirs: ["out"] })
// @ts-expect-error A process requires a resolved command.
accept({ ...process, argv: undefined })
// @ts-expect-error A process requires at least its executable.
accept({ ...process, argv: [] })
// @ts-expect-error A process cannot carry a native fetch payload.
accept({ ...process, lane: fetch.lane })
// @ts-expect-error A Shell service requires a command.
accept({ ...service, argv: undefined })
// @ts-expect-error Shell.Serve and Docker.Serve require different lanes.
accept({ ...service, rule: "Docker.Serve" })
// @ts-expect-error A stamp needs all stamp operands.
accept({ ...stamp, lane: { kind: "docs-check", stamp: "page.stamp" } })
// @ts-expect-error Agent.Lint cannot carry a diff execution flavor.
accept({ ...agent, lane: { ...agent.lane, flavor: "diff" } })
// @ts-expect-error Agent.Lint cannot carry a diff payload.
accept({ ...agent, lane: { ...agent.lane, payload: diff } })
// @ts-expect-error An ordinary rule name cannot bypass native dispatch via body.
accept({ ...fetch, family: "body", rule: "Fetch", lane: undefined })
// @ts-expect-error A refusal requires an explanation.
accept({ ...refused, refusal: undefined })
// @ts-expect-error A refusal cannot masquerade as an executable lane.
accept({ ...refused, lane: fetch.lane })
