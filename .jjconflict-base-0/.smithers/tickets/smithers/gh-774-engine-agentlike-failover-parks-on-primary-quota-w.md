# engine: AgentLike[] failover parks on primary quota without trying a healthy fallback

GitHub: https://github.com/smithersai/smithers/issues/774

## What happens

For a Task configured with `agent={[codex, claude]}`, if the primary agent reaches runtime `AGENT_QUOTA_EXCEEDED`, Smithers 0.27 parks the task/run in `waiting-quota` without trying the healthy fallback candidate.

The engine walks the chain for preflight failures, but the runtime failure path converts quota directly to `waiting-quota`.

## Expected

When a later chain candidate exists, advance to it immediately without consuming the task retry budget. Enter `waiting-quota` only after every remaining candidate is quota-blocked, preserving reset metadata.

## Regression tests

- primary quota + fallback success => task finishes via fallback
- all candidates quota-blocked => run enters `waiting-quota`
- existing auth/preflight failover behavior remains unchanged

Found while hardening the multi issue-swarm provider chains against subscription resets.
