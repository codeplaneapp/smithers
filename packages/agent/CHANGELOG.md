# @smthrs/agent

## [Unreleased]

### Added

- Added `defaultModelRetryWindowMillis` (45,000 ms), a wall clock on the transport retry ladder. Five rungs bounds how many attempts are made, not what they cost: r92 of the SWE-bench full benchmark burned ten `transport` retries and $0.85 across two instances against a socket that stayed dead for half a minute, and each of those attempts re-sent a whole prompt and streamed a partial body before dying. The window is the declared ladder's own jittered ceiling plus a rung's headroom, so a transport that fails fast still gets all five rungs, while one whose attempts are slow stops when the window closes. Elapsed time is the schedule's own, on the injected clock.

- `AgentSession.trace` now journals `control.agent.vacuous-verification-observed` with its payload — the stored check, the flow, and the controller's identity for that call — rather than letting it fall through to an empty one. The control that emits it is unwired from `CellTurn` as of the r93 verdict, so no new run produces the row; the mapping stays so the r93 journals that carry it keep reading and so a controlled re-measure needs no change here.

- Added `StandardFlows.tests`, which binds `@smthrs/std`'s `test` flow to a
  host's `TestRunner` declaration. A tool no production composition offers is a
  tool that does not exist, which is the same reason all seven filesystem flows
  are bound rather than two.

- `StandardFlows.shell` now supplies a `Container` transport, defaulting to the
  docker/podman CLI, so `bash`'s `container` field means something in the
  production composition. Without one the field resolves `{ ok: false }` with
  "this host has no container transport", and the agent goes back to typing
  `docker exec c bash -lc '…'` itself — the quoting stack that cost the measured
  SWE-bench program twelve failed probes and one instance's most expensive frame.
  A host with a different route passes its own transport; a host with neither
  docker nor podman fails the spawn with the shell's own "not found", which is
  the honest answer.

### Changed

- Renamed the package from `@smthrs/engine-harness` to `@smthrs/agent`. The
  package is named for what it ships: the flows agent, plus the two adapters
  that run it.
- Renamed `CellHarness` to `Agent` and made it a `Context.Service`. The loop is
  reached through the `Agent` tag rather than a bare `run` export, so a future
  agent that drives a foreign CLI is another implementation of the same service.
  `Agent.layer` provides the production one, `Agent.layerNoop` a silent one, and
  `Agent.layerDefaults` the browser-safe sandbox and steering defaults the old
  `CellHarness.layer` provided.
- Renamed `HarnessExecutor` to `AgentSession`, and its durable flow id from
  `engine-harness/agent` to `agent/run`.
- Collapsed `Options.seat` / `model` / `route` / `contextWindowTokens` into one
  resolved `Seat.Seat`. There is now exactly one resolved-seat record, produced
  only by a `SeatResolver`.
- Changed the composition identity folded into every step key this package
  derives from `flows/engine-harness/composition/v1:` to
  `flows/agent/composition/v1:` (`FlowEngineLike.ts`). Every step cached under
  the old prefix therefore misses. That is intentional: pre-release identity
  strings track module paths, and the package moved.
- Changed the failure an `AgentAction` reports when the host cannot serve its
  declared seat. It is now `Seat.SeatUnresolved` rather than a `HarnessError`,
  and `AgentAction.AgentFailure` carries the new member.

### Added

- Journaled `control.agent.discipline-armed` once at run start with the
  read-only and frame caps and every effective sandbox limit, so a run that
  never reaches completion still proves what it armed.

- Added `Agent.Options.readOnlyCap`, armed by `AgentSession` for every task run
  (`AgentSession.Options.readOnlyCap`, default `CellTurn.defaultReadOnlyFrames`).
  It caps consecutive frames that write nothing; a run that is meant only to
  answer leaves it unset.
- Journaled `durationMillis` on `control.agent.model-settled`, the wall-clock
  duration of that one sealed model call.
- Added `Seat`: the resolved seat record, `Seat.modelIdOf`, and the typed
  `Seat.SeatUnresolved` failure. The declared half stays an unvalidated string,
  because the resolver owns the seat vocabulary.
- Added `SeatResolver`, the host seam that turns a declared seat string into a
  live model. `AgentSession` and `AgentAction` both take it as a service instead
  of a `resolveSeat` option, so a composition installs one resolver rather than
  threading a function through every entry point. The context-window catalog
  moved here as `SeatResolver.contextWindowTokensFor`.

- Placed the run's task prompt in a prefix segment so it survives every frame; it previously lived in the rebuilt tail and vanished after frame one.
- Widened the sealed step's transient retry to five one-second-doubling attempts; a destroyed HTTP/2 session outlives a half-second backoff.

- Made agent reasoning effort configurable: the flow's `effort:` frontmatter wins, then the host's `Options.reasoningEffort`, then the `high` default.

- Defaulted every executor-launched run to medium reasoning effort; an unset effort left the model with near-zero thinking budget.

- Added durable `control.agent.*` trail projections with occurrence timestamps
  and bounded failure causes for executor runs.
- Added workspace-relative file boundary conversion for cell calls.
- Added transient sealed-model retries while preserving non-retryable model
  failures.

## [0.1.0] - 2026-08-05

### Added

- Initial release.
