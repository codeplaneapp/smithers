# Lane `runs` — the run lifecycle (the seven P0 gaps)

Brief: `../UI-COVERAGE-GAPS.md` §P0. Laws as every lane (EMBED LAW, NO
INVENTION, no useEffect, state in collections, every act a flow; consequential
acts confirm). Depends on nothing in flight; touches the flow-run card, the
gateway relay allowlist, and adds one card kind. Coordinate on
`Flows.ts` / `registry.test.ts` with any lane still editing them.

Scope, in order:
1. **Relay allowlist.** `apps/server/src/gatewayRpc.ts` gains List runs,
   Resume, Steer (Message|Seat|Thinking|Tools), Signal, and the `transcript`,
   `run-events`, `approvals` (no runId) projections; server tests.
2. **`run-list` card.** Header: repo and one mono count line by status; rows
   runId · flow · status · waiting reason · age · turns/calls; a row opens
   the flow-run card; filter chips re-invoke `runs.list` with the chip's
   argument; footer `Stop all N` (confirm). Flows `runs.list [status] [flow]
   [by=] [lineage=] [owner/repo]`, `runs.open <runId>`, `flow.run.stop-all
   [owner/repo]` (confirm).
3. **`approvals-inbox` card.** Rows run · flow · question · age with
   Approve/Deny bound to the existing `approval.approve` / `approval.deny`
   by row id; count in the header mono line; `system.recommend` suggests
   `approvals.list` when non-zero. Flows `approvals.list [owner/repo]`,
   `approvals.open <runId>`.
4. **flow-run card: lifecycle.** Stop (confirm, optional reason) on every
   non-terminal phase; Resume when parked and not on an approval; Run again
   when terminal; the phase line names every waiting reason with its unblock
   act: `waiting · provider quota · resumes 12:40`, `waiting · timer ·
   14 min`, `waiting · signal <name>` (Signal button opening one JSON row),
   `accepted · nothing is driving it` (Resume). Flows `runs.resume`,
   `runs.rerun`, `runs.signal <runId> <name> [json]`; `flow.run.stop` gains
   `[reason]`.
5. **flow-run card: steer.** A steer composer row under the steps plus a
   mono strip `seat ▾ · thinking ▾ · tools ▾`; a queued steer reads
   `steering pending · delivered at the next turn` until delivered. Flows
   `runs.steer <runId> <message>`, `runs.seat <runId> <provider:model>`,
   `runs.thinking <runId> <level>`, `runs.tools <runId> <tool,...>`.
6. **flow-run card: Transcript and Events facets.** Transcript rows turn · at
   · kind · text with a follow toggle, maximize for the full log; Events
   shows raw ControlEvent JSON only under `debug.verbose`. Flows
   `runs.logs <runId> [--follow]`, `runs.events <runId>`.
7. Docs: LOCAL-APP.md cards section; WORKBENCH-UX.md gains a "Runs" note.

Exit: relay tests; seam tests with doubles for every projection and
operation; card tests per phase and waiting reason; T1 spec launching a
fixture flow, steering it, stopping it, and seeing it in the run inbox.
