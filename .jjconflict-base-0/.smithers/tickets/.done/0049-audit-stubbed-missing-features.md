# Stubbed & missing features — remaining

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#302](https://github.com/smithersai/smithers/issues/302) · 2026-06-16 bulletproof audit
> Resolved 2026-06-19: 5 implemented + 3 documented by-design = all 8 items addressed

## Disposition note (2026-06-19): AlertRuntime / alertPolicy.reactions are by-design

The two alert findings (AlertRuntime is a no-op; `alertPolicy.reactions` never
consumed) are **not defects against the documented contract**. `docs/guides/alerting.mdx`
states plainly: *"Rule names are policy keys for your integration; the core engine
does not attach built-in behavior to those names in this release."* The alert
policy is intentionally **declarative metadata** that Smithers stores and exposes
(durable alert rows via the DB adapter + CLI), with rule evaluation/reactions
delegated to the runtime integration. Implementing engine-side rule evaluation
would contradict the documented design — it is a **future product feature**, not a
bug fix, and should be scoped deliberately (with a docs change) rather than slipped
in. Marked accordingly below; left unchecked because no code change is correct here.

## Disposition note (2026-06-19): Gateway "RPC drift" is intentional legacy aliasing

The "10 live RPC methods absent from GATEWAY_RPC_DEFINITIONS" finding is contradicted
by the gateway contract test `packages/gateway/tests/rpc-contract.test.ts:163`
("maps legacy methods to stable definitions **without duplicating the contract**").
The dotted methods (`health`, `approvals.list`, `workflows.list`, `runs.diff`,
`getDevToolsSnapshot`, `runs.rerun`, `runs.create`, `approvals.decide`, `cron.trigger`,
`frames.*`, `attempts.*`) are deliberate legacy/compat aliases: `canonicalGatewayRpcMethod`
maps them to the canonical method, `getRequiredScopeForGatewayMethod` scopes them, and
`isGatewayRpcMethod("runs.create") === false` keeps them out of the frozen v1 contract
on purpose. Adding them to GATEWAY_RPC_DEFINITIONS would duplicate the contract, exactly
what the tested design avoids. By-design, not drift — left unchecked, no code change correct.

## Context

Documented features that still ship as no-op stubs or are missing. Memory token-limiting/summarization, semantic-MCP time-travel tools, openapi generate, non-JSON bodies, scorer context/groundTruth, and the gui shortcut all landed; these remain.

Each item below is still open in current `main`. Text is the original audit finding (severity + file:line). `remaining:` notes come from the 2026-06-18 verification pass. Check items off here as they land, and mirror the check-off on issue #302.

## Open items

- [x] **P1** AmpAgent cannot resume a session — it is the only CLI adapter that never wires resumeSession into buildCommand — `packages/agents/src/AmpAgent.js:196-240, packages/agents/src/AmpAgentOptions.ts`
  - _remaining:_ buildCommand must read params.options?.resumeSession and emit `amp threads continue <id>` per the manifest; add session field to AmpAgentOptions. Still unimplemented.
- [x] **P2** Several documented remote sandbox targets (gVisor, Daytona, Cloudflare) have no shipped or example provider — `docs/index.mdx:240-241, README.md:170-174, packages/sandbox/src/`
  - _remaining:_ Ship example providers (or links) for gVisor/Daytona/Cloudflare, or trim README/docs to the targets that actually have a provider. Still a documented-but-absent surface.
- [x] **P2** `smithers memory` and `smithers cron` CLI groups are partial vs their underlying store/adapter capabilities — `apps/cli/src/index.js:2230-2328`
  - _remaining:_ Add `memory get`, `memory set`, `memory rm` wrapping store.getFact/setFact/deleteFact. Memory CLI still partial; cron resolved.
- [x] **P2** ./BaseCliAgent subpath export declares types target missing its runtime exports — ``
  - _remaining:_ Emit a dedicated ./src/BaseCliAgent/index.d.ts re-exporting the module symbols and set it as the subpath's types. Helper imports still untyped.
- [x] **P2** SuperSmithers 'apply' task is a no-op stub that returns a literal and writes nothing — `packages/components/src/components/SuperSmithers.js:74-91`
  - _remaining:_ Implement the compute fn to read prior propose-task output and apply edits to disk (or gate behind dryRun), or document as report-only. Still a no-op stub.
- [x] (by-design) **P1** AlertRuntime is a no-op stub; alertPolicy.rules are never evaluated and no alert is ever inserted — `packages/engine/src/alert-runtime.js:7-22; wired at packages/engine/src/engine.js:5488-5514 and 6059-6088`
  - _remaining:_ Implement start()/stop() to subscribe to the eventBus, evaluate policy.rules, and insertAlert/createHumanRequest on fire. Still a no-op stub.
- [x] (by-design) **P2** alertPolicy.reactions are never consumed anywhere (entire alert reaction pipeline unimplemented) — ``
  - _remaining:_ On rule fire, look up policy.reactions and execute (requestCancel/pause/createHumanRequest) via the injected services. Still unimplemented.
- [x] (by-design) **P1** 10 live runtime RPC methods are absent from the canonical GATEWAY_RPC_DEFINITIONS contract (real drift, opposite of the prompt's premise) — `packages/gateway/src/rpc/index.ts:397-707`
  - _remaining:_ Add these live methods (or an internal contract section) to GATEWAY_RPC_DEFINITIONS so every dispatched method is contracted. Drift remains.
