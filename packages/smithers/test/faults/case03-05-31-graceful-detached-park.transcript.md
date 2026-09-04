# Graceful detached park rehearsal

Observed on 2026-09-04 from the frozen release worktree. The project lived at
`/tmp/smithers-park-verify.t6f6HL/project`, with
`SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home`. Current rc.0 does not
read `SMITHERS_HOME`; the isolated project root held both SQLite databases and
all logs. Every CLI invocation used the real `packages/smithers/src/bin.ts`
entry under Node and an explicit `gtimeout`.

The flow was a Markdown prompt flow using `gemini:gemini-2.5-pro` first and
then `cerebras:gpt-oss-120b`. Gemini returned HTTP 429. Cerebras produced the
requested cell:

```js
const decision = await ctx.call("ask", { question: "continue the detached durability check?", options: ["yes", "no"] })
ctx.done("decision=" + decision.approved)
```

## Discovery

```console
$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 30s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json ls
{"_tag":"flows","items":[{"description":"Parks on one in-run approval, then reports the decision.","flowId":"approval-park"}]}
EXIT=0
```

## Detached launch

The command returned within its 180-second bound. The observed wall time was
30.2 seconds before the first poll and less than 30 seconds after that poll.

```console
$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 180s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json up approval-park -d
{"detached":true,"logFile":"/private/tmp/smithers-park-verify.t6f6HL/project/.flows/logs/run-3.log","runId":"run-3"}
EXIT=0
```

The detached log contained:

```text
SMITHERS_DETACHED_ADMISSION=run:21975-mtn209ph-tz6uyb runId=run-3
{
  "_tag": "Accepted",
  "receiptId": "approve:plan-3",
  "runId": "run-3"
}
```

## State after the launcher and child exited

Eight seconds after launch, the detached owner PID no longer existed and the
real CLI read the durable control row as `waiting-approval`.

```console
$ kill -0 23081
DETACHED_PID_23081=gone

$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 30s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json ps
{"_tag":"runs","items":[{"createdAt":1788532407892,"flowId":"approval-park","parkedBy":"{\"hostId\":\"Williams-MacBook-Pro-3.local\",\"pid\":23081,\"nonce\":\"9c96369d-89ee-40ab-bb12-e346b3fcc1ea\"}","planDigest":"5c4a8e2b8ee6656aba2690c847c5a45fbb198f75d6cb09911901b6ce5383bef6","planId":"plan-3","runId":"run-3","status":"waiting-approval","steering":{"pending":0},"updatedAt":1788532410659}]}
PS_EXIT=0
```

The approval token read directly from `.flows/control.db` was unresolved:

```json
[
  {
    "target_tag": "Node",
    "run_id": "run-3",
    "target_id": "ask/run-3/cd1772575bf0cf44e00af5937462a533eed17b3be23d552687462bc10ca3213e",
    "token_id": "ask/run-3/cd1772575bf0cf44e00af5937462a533eed17b3be23d552687462bc10ca3213e",
    "target_json": "{\"_tag\":\"Node\",\"runId\":\"run-3\",\"requestId\":\"ask/run-3/cd1772575bf0cf44e00af5937462a533eed17b3be23d552687462bc10ca3213e\",\"digest\":\"cd1772575bf0cf44e00af5937462a533eed17b3be23d552687462bc10ca3213e\",\"envelope\":{\"capabilities\":[],\"flows\":[\"ask\"],\"budget\":{}}}",
    "resolved": 0,
    "decision_principal_json": null
  }
]
```

## Resume before the decision

The bounded resume returned in 26.8 seconds. It did not hang and did not
cancel the row.

```console
$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 45s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json run --resume run-3
{"_tag":"Accepted","receiptId":"cli:resume:run-3:23","runId":"run-3"}
RESUME_EXIT=3

$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 30s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json ps
{"_tag":"runs","items":[{"createdAt":1788532407892,"flowId":"approval-park","parkedBy":"{\"hostId\":\"Williams-MacBook-Pro-3.local\",\"pid\":25508,\"nonce\":\"82eb02bf-1843-47b3-9a7c-874cebe62eb7\"}","planDigest":"5c4a8e2b8ee6656aba2690c847c5a45fbb198f75d6cb09911901b6ce5383bef6","planId":"plan-3","runId":"run-3","status":"waiting-approval","steering":{"pending":0},"updatedAt":1788532477054}]}
PS_EXIT=0
```

## Approve and settle

The real approval command returned in 41.7 seconds, within its 90-second
bound. It resumed the run in the same invocation.

```console
$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 90s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json approve '<stored node approval payload>'
{"_tag":"Accepted","receiptId":"approve:ask/run-3/cd1772575bf0cf44e00af5937462a533eed17b3be23d552687462bc10ca3213e","runId":"run-3"}
APPROVE_EXIT=0

$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 30s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json ps
{"_tag":"runs","items":[{"createdAt":1788532407892,"flowId":"approval-park","planDigest":"5c4a8e2b8ee6656aba2690c847c5a45fbb198f75d6cb09911901b6ce5383bef6","planId":"plan-3","runId":"run-3","status":"completed","steering":{"pending":0},"updatedAt":1788532577460}]}
PS_EXIT=0

$ env SMITHERS_HOME=/tmp/smithers-park-verify.t6f6HL/home gtimeout 30s node --no-warnings <worktree>/packages/smithers/src/bin.ts --json output run-3 result
{"flowName":"agent","nodeId":"result","outcome":"success","settledAt":1788532577459,"settledSequence":88,"value":"no change needed; decision approved=true"}
OUTPUT_EXIT=0
```

No command in the successful path reached its timeout.
