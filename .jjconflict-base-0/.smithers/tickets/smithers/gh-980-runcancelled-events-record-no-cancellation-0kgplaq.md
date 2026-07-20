# RunCancelled events record no cancellation source (signal vs RPC vs CLI unattributable)

GitHub: https://github.com/smithersai/smithers/issues/980

## Problem

A healthy 64-wide ticket-fleet run (run-1783727681742) was externally cancelled while progressing normally. The only durable evidence is:

```json
{"type":"RunCancelled","runId":"run-1783727681742","timestampMs":1783733665206,"correlation":{...}}
```

The engine log shows the shutdown shape — every live codex child got `child process interrupted ... reason='CLI aborted'` within ~1s, then `timed out waiting for aborted tasks to settle`, then `status: cancelled` — which is the SIGTERM-received pattern, but nothing records:

- whether the cancel came from a POSIX signal (and which), the `cancel` CLI, an RPC (`cancelRun`), or engine-internal policy;
- the requesting pid / client identity for RPC/CLI paths;
- a freeform reason.

With multiple sessions and agents sharing one workspace, an unattributable cancel is nearly undebuggable — we could not determine the killer after the fact.

## Proposal

Extend the `RunCancelled` payload (and the run's terminal DB row) with `source: {kind: "signal"|"rpc"|"cli"|"engine", detail?: string, signal?: string, clientPid?: number, requestId?: string}`. Signal handlers know the signal; RPC/CLI paths know their caller (request id / argv). Even a best-effort `detail` string would make shared-workspace incidents attributable.

## Repro-ish

1. `smithers up <wf> --run-id X --resume` in one process.
2. `kill -TERM <engine pid>` from anywhere.
3. `smithers inspect X` → cancelled, with no way to distinguish that from `smithers cancel X` or a gateway RPC cancel.
