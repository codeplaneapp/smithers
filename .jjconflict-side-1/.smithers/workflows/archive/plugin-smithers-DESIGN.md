# Design Proposal — `plugin-smithers`: a first-class ElizaOS plugin for Smithers

> **Author:** Claude (for will@tevm.tech) · **Target:** `@elizaos/core` **^1.7.2** (v1.x) · **Status:** proposal for review
>
> This tab is the *recommendation*. The **Research** tab is the authoritative ElizaOS-plugin reference it is built on — every type and field used below is defined there.

---

## 0. TL;DR

Build **`plugin-smithers`**, an ElizaOS v1.x plugin that lets an Eliza agent **drive Smithers** — launch workflows, watch them, answer approval gates, and report progress back into the chat — using Smithers as the durable control plane.

- **Direction:** this is the *mirror image* of what we already ship. `agent-eliza` makes Eliza a **model backend for Smithers**. `plugin-smithers` makes **Smithers a capability inside Eliza**. Together they close the loop.
- **Precedent:** we already did exactly this shape for another agent framework — **`packages/pi-plugin`** integrates Smithers into the PI coding agent over (a) an **MCP stdio** tool surface and (b) the **HTTP/SSE gateway** for live run control. `plugin-smithers` is the same idea expressed in Eliza's primitives.
- **Shape (the canonical Eliza external-integration pattern):** **one Service** owns the connection + in-flight registry; **Actions** expose operations; a **Provider** injects live run state into the prompt; an **Evaluator** records outcomes; optional **routes** expose an inspector UI / webhook.
- **Transport:** connect to a running Smithers **Gateway** with the typed **`SmithersGatewayClient`** (`@smithers-orchestrator/gateway-client`). Falls back to the plain `/v1` REST+SSE surface for a zero-Smithers-dependency build.
- **Home:** add it to this monorepo as **`packages/eliza-plugin`** (mirrors `pi-plugin`), so we maintain it at the source — but publish it under a non-`@elizaos/*` name so Eliza users can `elizaos plugins add` it.

---

## 1. Direction: where this sits relative to what we have

```
        ┌───────────────────────────── Smithers (durable control plane) ─────────────────────────────┐
        │   engine · scheduler · driver · gateway (:7331) · MCP server (`smithers --mcp`)             │
        └───────────▲───────────────────────────────────────────────────────────────▲────────────────┘
                    │ (A) agent-eliza  — EXISTING                       (B) plugin-smithers — PROPOSED │
                    │     Eliza is a *backend*: ElizaAgent              Smithers is a *capability*:     │
                    │     implements smithers AgentLike,               Eliza Actions/Service call the   │
                    │     runs runtime.useModel(...) as a Task         Gateway to launch & steer runs   │
        ┌───────────┴───────────────┐                       ┌──────────────────────────┴───────────────┐
        │  Smithers <Task> picks    │                       │  Eliza AgentRuntime loads plugin-smithers │
        │  ElizaAgent as its model  │                       │  → agent can "run the deploy workflow"    │
        └───────────────────────────┘                       └───────────────────────────────────────────┘
```

- **`agent-eliza` (already shipped, `@smithers-orchestrator/agent-eliza`)** — `ElizaAgent` implements Smithers' `AgentLike` (`generate()`), dynamically imports `@elizaos/core`, builds an `AgentRuntime`, and calls `runtime.useModel("TEXT_LARGE", …)`. Smithers orchestrates; Eliza is one model backend.
- **`plugin-smithers` (this proposal)** — an `@elizaos/core` `Plugin`. Eliza orchestrates the conversation; Smithers becomes a tool the agent reaches for when work is long-running, multi-step, crash-safe, or needs approvals.

These are complementary, not redundant. With both installed you get a **round trip**: a Smithers workflow can use an Eliza agent as a step *and* an Eliza agent can launch Smithers workflows.

---

## 2. Goals & non-goals

**Goals**
1. Let the Eliza LLM **launch a Smithers workflow** by name with structured input.
2. **Surface live run state** (status, current node, pending approvals, errors) into the agent's context every turn.
3. **Bridge human-in-the-loop**: when a run hits an approval gate or an `ask_human` request, the agent proactively asks in chat; the user's reply resolves it.
4. **Report progress proactively** — when a tracked run changes state or finishes, the agent posts an update without being re-prompted.
5. Stay **decoupled & durable**: Smithers is a separate long-lived control plane; the Eliza agent is just a client and can restart without losing runs.

**Non-goals (v1)**
- Re-implementing the Smithers engine inside the Eliza process (the in-process `runWorkflow` path is possible but heavyweight — see §4).
- Authoring Smithers workflows from Eliza (that's a coding-agent job; the agent can still *write files*, but the plugin's job is to *drive* the control plane).
- A full TUI inspector (pi-plugin already has one; we expose a thin web inspector via routes instead).

---

## 3. Architecture overview

```
 Eliza message ──▶ plugin-bootstrap loop ──▶ composeState() ─────────────┐
                                                │                        │
                                                ▼                        ▼
                                   SMITHERS_RUNS provider        LLM picks an Action
                                   (live run table into          (RUN_WORKFLOW, APPROVE, …)
                                    the prompt)                          │
                                                                        ▼
                            ┌───────────────────────────── SmithersService ──────────────────────────────┐
                            │  SmithersGatewayClient (WS+RPC)  ·  Map<runId,{roomId,status,approvals}>     │
                            │  launchRun · getRun · submitApproval · submitSignal · cancelRun · listRuns   │
                            │  streamRunEvents(runId) ──▶ on state-change / approval / done:                │
                            │     runtime.emitEvent(MESSAGE_RECEIVED, { message, callback })  ← proactive   │
                            └───────────▲─────────────────────────────────────────────────────▲────────────┘
                                        │ HTTP/WS :7331                                         │
                  ┌─────────────────────┴───────────────────┐                ┌─────────────────┴───────────────┐
                  │   Smithers Gateway (durable)             │                │  optional plugin routes:         │
                  │   `smithers gateway` / `smithers up -d`  │                │  GET /smithers/runs (status)     │
                  └──────────────────────────────────────────┘                │  POST /smithers/callback (hook)  │
                                                                              │  STATIC /smithers (inspector UI) │
                                                                              └──────────────────────────────────┘
 after a turn ─▶ SMITHERS_RUN_OUTCOME evaluator ─▶ runtime.createMemory(..., "facts")  (recall completed runs)
```

The five plugin components and what each maps to:

| Plugin field | Component | Responsibility | Maps to (Smithers / pi-plugin analog) |
|---|---|---|---|
| `services` | **`SmithersService`** | Owns the `SmithersGatewayClient`, base URL + token, the `Map` of tracked runs, and the live event subscriptions. | pi-plugin's module-level MCP/HTTP connection mgmt + `DevToolsStore` |
| `actions` | **RUN / CHECK / LIST / APPROVE / DENY / CANCEL / ANSWER_HUMAN** | Discrete operations the LLM invokes. | pi-plugin's registered commands/tools (`smithers-run`, `smithers-approve`, …) |
| `providers` | **`SMITHERS_RUNS`** | Inject active runs + pending approvals into context. | pi-plugin's `before_agent_start` system-prompt injection |
| `evaluators` | **`SMITHERS_RUN_OUTCOME`** | Persist completed-run summaries to memory. | (new) |
| `routes` | **`/smithers/*`** | Optional status JSON, callback webhook, static inspector UI. | pi-plugin's `RunInspector` views |
| `config`/`init` | **`SMITHERS_URL` / `SMITHERS_API_KEY`** | Validate connection settings. | pi-plugin's `--smithers-url` / `--smithers-key` flags |

---

## 4. The transport decision

Three ways the plugin can reach Smithers. **Recommendation: Layer B (remote gateway client).**

| | **A. In-process engine** | **B. Remote Gateway client ✅** | **C. MCP stdio** |
|---|---|---|---|
| How | Bundle the engine; `createSmithers()` → `runWorkflow(wf,{input,onProgress})` in the Eliza process | `SmithersGatewayClient` (WS+RPC) → a `smithers gateway` running separately | Spawn `smithers --mcp`; call tools over `@modelcontextprotocol/sdk` |
| Durability | Dies with the Eliza process | **Survives Eliza restarts** (control plane is separate) | Subprocess tied to Eliza lifetime |
| Coupling | Heavy: engine + JSX build + DB in Eliza | **Thin: one client dep** | Medium: MCP client + subprocess mgmt |
| Live events | `onProgress` callback | **`streamRunEvents()` async iterator** | tool polling (`watch_run`/`get_run`) |
| Best when | Eliza *owns* the workflows & wants tight embedding | **Eliza is a client of a shared, long-lived Smithers** | You want to auto-mirror the whole semantic tool surface |
| Smithers dep | `smithers-orchestrator` (engine) | `@smithers-orchestrator/gateway-client` | `@modelcontextprotocol/sdk` + a `smithers` binary on PATH |

**Why B:** it matches Smithers' reason for existing — a *durable* control plane. The Eliza agent should be a disposable client of it. It's also the lightest dependency and gives first-class live streaming. We keep **C (MCP)** in our back pocket as an *optional* way to expose the full 21-tool surface as a single escape-hatch action (see §10), and **A** documented for users who want a single process.

> **Zero-Smithers-dependency variant.** If we publish `plugin-smithers` fully standalone and don't want a versioned dep on `@smithers-orchestrator/gateway-client`, the Service can hand-roll the same calls over the stable **`/v1` REST + SSE** surface (exactly what `pi-plugin/src/api/*` does): `POST /v1/runs`, `GET /v1/runs/:id`, `GET /v1/runs/:id/events` (SSE), `POST /v1/runs/:id/nodes/:nodeId/approve|deny`, `POST /v1/runs/:id/signals/:name`. Same design, ~80 lines of `fetch`. Lead with the typed client; offer this as a fallback.

---

## 5. Component-by-component design

### 5.1 `SmithersService` — the connection + run registry

The long-lived singleton. It is the *only* thing that talks to Smithers; everything else goes through `runtime.getService('smithers')`.

```ts
import { Service, type IAgentRuntime, EventType, type Memory, type HandlerCallback, logger } from '@elizaos/core';
import { SmithersGatewayClient } from '@smithers-orchestrator/gateway-client';

declare module '@elizaos/core' {
  interface ServiceTypeRegistry { SMITHERS: 'smithers'; }
}

export interface TrackedRun {
  runId: string;
  workflow: string;
  roomId: string;          // the Eliza room that launched it — where we report back
  entityId: string;        // the user who launched it
  status: string;          // running | finished | failed | cancelled | waiting-approval
  pendingApprovals: { nodeId: string; prompt?: string }[];
  lastError?: string;
}

export class SmithersService extends Service {
  static serviceType = 'smithers' as const;
  capabilityDescription =
    'Connection to the Smithers durable control plane: launch, watch, approve and cancel workflow runs.';

  private client!: SmithersGatewayClient;
  private runs = new Map<string, TrackedRun>();
  private subs = new Map<string, AbortController>();

  static async start(runtime: IAgentRuntime): Promise<SmithersService> {
    const svc = new SmithersService(runtime);
    const url = String(runtime.getSetting('SMITHERS_URL') ?? 'http://127.0.0.1:7331');
    const apiKey = runtime.getSetting('SMITHERS_API_KEY');
    svc.client = new SmithersGatewayClient({ url, apiKey: apiKey ? String(apiKey) : undefined });
    logger.info(`[smithers] connected to ${url}`);
    return svc;
  }

  // ---- thin wrappers the Actions call ---------------------------------------
  listWorkflows() { return this.client.listWorkflows({}); }
  getRun(runId: string) { return this.client.getRun({ runId }); }
  listRuns() { return this.client.listRuns({}); }
  cancel(runId: string) { return this.client.cancelRun({ runId }); }
  approve(runId: string, nodeId: string, value?: unknown, note?: string) {
    return this.client.submitApproval({ runId, nodeId, decision: { approved: true, value, note } });
  }
  deny(runId: string, nodeId: string, note?: string) {
    return this.client.submitApproval({ runId, nodeId, decision: { approved: false, note } });
  }
  answerHuman(runId: string, correlationKey: string, payload: unknown) {
    return this.client.submitSignal({ runId, correlationKey, payload });
  }

  // ---- launch + start streaming back into the originating room --------------
  async launch(workflow: string, input: unknown, roomId: string, entityId: string) {
    const { runId } = await this.client.launchRun({ workflow, input: input as Record<string, unknown> });
    this.runs.set(runId, { runId, workflow, roomId, entityId, status: 'running', pendingApprovals: [] });
    this.watch(runId);                       // fire-and-forget background stream
    return runId;
  }

  snapshot(): TrackedRun[] { return [...this.runs.values()]; }
  get(runId: string) { return this.runs.get(runId); }

  // ---- the bridge: long-running run → proactive Eliza message ---------------
  private watch(runId: string) {
    const ac = new AbortController();
    this.subs.set(runId, ac);
    void (async () => {
      const tracked = this.runs.get(runId)!;
      try {
        for await (const ev of this.client.streamRunEvents({ runId }, { signal: ac.signal })) {
          const next = this.reduce(tracked, ev);            // update status/approvals/errors
          if (next.changed) await this.report(tracked, next.message);   // proactive chat update
          if (this.isTerminal(tracked.status)) break;
        }
      } catch (err) {
        logger.warn(`[smithers] stream for ${runId} ended: ${String(err)}`);
      } finally {
        this.subs.delete(runId);
      }
    })();
  }

  /** Inject a synthetic inbound message so plugin-bootstrap generates a proactive agent reply. */
  private async report(run: TrackedRun, text: string) {
    const message: Memory = {
      entityId: this.runtime.agentId,        // system-originated
      agentId: this.runtime.agentId,
      roomId: run.roomId as any,
      content: { text, source: 'smithers' },
    } as Memory;
    const callback: HandlerCallback = async () => [];   // bootstrap delivers via the room's send handler
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime, message, callback, source: 'smithers',
    });
  }

  private reduce(run: TrackedRun, ev: unknown): { changed: boolean; message: string } { /* … see §6 … */ return { changed: false, message: '' }; }
  private isTerminal(s: string) { return s === 'finished' || s === 'failed' || s === 'cancelled'; }

  async stop() {
    for (const ac of this.subs.values()) ac.abort();
    this.subs.clear();
    this.runs.clear();
  }
}
```

> Method names (`launchRun`, `getRun`, `listRuns`, `submitApproval`, `submitSignal`, `cancelRun`, `streamRunEvents`, `listWorkflows`) are the real `SmithersGatewayClient` surface confirmed in `packages/gateway-client`. `submitApproval` takes `{ runId, nodeId, decision: { approved, value?, note? } }`.

### 5.2 Actions — what the LLM can invoke

Hand-authored, **intent-shaped** actions (not 1:1 MCP proxies — see §10 for why). Each follows the v1.x `Action` contract: `name` (SCREAMING_SNAKE), `validate` (gate on the Service existing), `handler` returning `ActionResult`, and a `HandlerCallback` for the user-facing line. Arguments are extracted from the message with `useModel(ModelType.OBJECT_SMALL, …)` because v1.x actions don't carry a typed parameter schema.

```ts
import {
  type Action, type ActionResult, type IAgentRuntime, type Memory, type State,
  type HandlerCallback, ModelType,
} from '@elizaos/core';
import type { SmithersService } from './service';

const svcOf = (rt: IAgentRuntime) => rt.getService<SmithersService>('smithers');

export const runWorkflowAction: Action = {
  name: 'RUN_SMITHERS_WORKFLOW',
  similes: ['START_WORKFLOW', 'LAUNCH_RUN', 'ORCHESTRATE', 'KICK_OFF_SMITHERS'],
  description:
    'Launch a Smithers workflow as a durable, multi-step run. Use when the user asks to run/orchestrate ' +
    'a named workflow, or for any long-running, crash-safe, or human-in-the-loop agent task.',
  validate: async (rt) => !!svcOf(rt),
  handler: async (rt, message, _state, _opts, callback): Promise<ActionResult> => {
    const svc = svcOf(rt)!;
    // 1) extract {workflow, input} from the user's text
    const workflows = await svc.listWorkflows();
    const extracted = (await rt.useModel(ModelType.OBJECT_SMALL, {
      prompt:
        `Available Smithers workflows: ${JSON.stringify(workflows)}.\n` +
        `From the user message, choose the workflow id and JSON input.\n` +
        `User: "${message.content.text}"\nReturn { "workflow": string, "input": object }.`,
    })) as { workflow: string; input: Record<string, unknown> };

    // 2) launch + start streaming back into this room
    const runId = await svc.launch(extracted.workflow, extracted.input ?? {}, String(message.roomId), String(message.entityId));

    await callback?.({ text: `🚀 Launched **${extracted.workflow}** — run \`${runId}\`. I'll report progress here.`, actions: ['RUN_SMITHERS_WORKFLOW'] });
    return { success: true, text: `Launched ${extracted.workflow} (${runId})`, data: { runId, workflow: extracted.workflow }, values: { lastSmithersRunId: runId } };
  },
  examples: [[
    { name: '{{user}}', content: { text: 'run the deploy workflow for the api service' } },
    { name: '{{agent}}', content: { text: '🚀 Launched deploy — run abc123. I\'ll report progress here.', actions: ['RUN_SMITHERS_WORKFLOW'] } },
  ]],
};

export const approveAction: Action = {
  name: 'APPROVE_SMITHERS_NODE',
  similes: ['APPROVE_RUN', 'APPROVE_GATE', 'CONFIRM_SMITHERS'],
  description: 'Approve a Smithers run that is paused at an approval gate. Use when the user says to approve/continue a waiting run.',
  validate: async (rt) => (svcOf(rt)?.snapshot().some(r => r.pendingApprovals.length) ?? false),
  handler: async (rt, message, _s, _o, callback): Promise<ActionResult> => {
    const svc = svcOf(rt)!;
    const waiting = svc.snapshot().flatMap(r => r.pendingApprovals.map(a => ({ runId: r.runId, ...a })));
    const pick = waiting.length === 1 ? waiting[0] : await resolveTarget(rt, message, waiting); // model-disambiguate if >1
    await svc.approve(pick.runId, pick.nodeId);
    await callback?.({ text: `✅ Approved \`${pick.nodeId}\` on run \`${pick.runId}\`.`, actions: ['APPROVE_SMITHERS_NODE'] });
    return { success: true, data: { runId: pick.runId, nodeId: pick.nodeId } };
  },
  examples: [],
};
```

Round out the set with the obvious siblings (same shape):

| Action | Service call | When the LLM picks it |
|---|---|---|
| `RUN_SMITHERS_WORKFLOW` | `launch()` | "run / orchestrate / kick off the X workflow" |
| `CHECK_SMITHERS_RUN` | `getRun()` | "what's the status of run X / the deploy" |
| `LIST_SMITHERS_RUNS` | `listRuns()` | "what's running / show my runs" |
| `APPROVE_SMITHERS_NODE` | `approve()` | "approve / yes continue / ship it" |
| `DENY_SMITHERS_NODE` | `deny()` | "deny / no / stop that step" |
| `CANCEL_SMITHERS_RUN` | `cancel()` | "cancel / kill the run" |
| `ANSWER_SMITHERS_HUMAN` | `answerHuman()` | run raised an `ask_human` question and the user answered |

> **Prompt guidance bonus.** We can reuse `renderSmithersAgentPromptGuidance(contract, …)` from `@smithers-orchestrator/agents/agent-contract` (the same helper `pi-plugin` uses) inside the provider (§5.3) to teach the model *when* to use each action — consistent guidance across PI and Eliza.

### 5.3 `SMITHERS_RUNS` provider — live state into the prompt

A **dynamic** provider so it only runs when relevant (or list it statically if you want every turn). It reads the Service's in-memory registry — **never throws**, returns empty on failure (per the research's hard rule for providers).

```ts
import type { Provider } from '@elizaos/core';
import type { SmithersService } from './service';

export const smithersRunsProvider: Provider = {
  name: 'SMITHERS_RUNS',
  description: 'Active Smithers workflow runs, their status, and any approvals waiting on the user.',
  dynamic: true,                       // opt-in via composeState; flip to false to always include
  position: 50,
  get: async (runtime) => {
    try {
      const svc = runtime.getService<SmithersService>('smithers');
      const runs = svc?.snapshot() ?? [];
      if (runs.length === 0) return { text: '', values: { smithersActiveRuns: 0 }, data: { runs: [] } };
      const lines = runs.map(r => {
        const appr = r.pendingApprovals.length ? `  ⚠ awaiting approval: ${r.pendingApprovals.map(a => a.nodeId).join(', ')}` : '';
        return `- ${r.workflow} \`${r.runId}\` → ${r.status}${r.lastError ? `  (error: ${r.lastError})` : ''}${appr}`;
      });
      return {
        text: `# Smithers runs in this conversation\n${lines.join('\n')}`,
        values: { smithersActiveRuns: runs.length, smithersAwaitingApproval: runs.some(r => r.pendingApprovals.length) },
        data: { runs },
      };
    } catch {
      return { text: '', values: {}, data: {} };
    }
  },
};
```

This is the Eliza-native equivalent of `pi-plugin`'s `before_agent_start` injection of `{ runId, status, nodeStates, errors }` — only here it's a first-class Provider folded into `composeState`.

### 5.4 `SMITHERS_RUN_OUTCOME` evaluator — remember what happened

Post-turn reflection: when a tracked run reached a terminal state this turn, write a fact to memory so the agent can recall it later ("did the deploy finish?").

```ts
import { type Evaluator, type IAgentRuntime, type Memory } from '@elizaos/core';
import type { SmithersService } from './service';

export const runOutcomeEvaluator: Evaluator = {
  name: 'SMITHERS_RUN_OUTCOME',
  description: 'Record the outcome of any Smithers run that finished during this interaction.',
  similes: ['RECORD_RUN', 'REMEMBER_WORKFLOW_RESULT'],
  alwaysRun: true,                     // even on turns the agent didn't "respond"
  validate: async (rt: IAgentRuntime) =>
    (rt.getService<SmithersService>('smithers')?.snapshot().some(r => ['finished', 'failed', 'cancelled'].includes(r.status)) ?? false),
  handler: async (rt, message) => {
    const svc = rt.getService<SmithersService>('smithers')!;
    for (const r of svc.snapshot().filter(r => ['finished', 'failed', 'cancelled'].includes(r.status))) {
      await rt.createMemory(
        { entityId: rt.agentId, agentId: rt.agentId, roomId: message.roomId,
          content: { text: `Smithers run ${r.runId} (${r.workflow}) → ${r.status}`, source: 'smithers' } } as Memory,
        'facts', true,
      );
    }
  },
  examples: [],
};
```

### 5.5 Routes — optional inspector + webhook (advanced)

Two useful endpoints, mounted by the agent server at `http://localhost:3000/smithers/*?agentId=…`:

```ts
import type { Plugin } from '@elizaos/core';
import type { SmithersService } from './service';

export const smithersRoutes: Plugin['routes'] = [
  // live status as JSON (cheap dashboard / debugging)
  { name: 'smithers-runs', path: '/smithers/runs', type: 'GET', public: true,
    handler: async (_req, res, runtime) => {
      const svc = runtime.getService<SmithersService>('smithers');
      res.json({ runs: svc?.snapshot() ?? [] });
    } },
  // webhook: an alternative to client-side streaming — the Gateway POSTs status here
  { name: 'smithers-callback', path: '/smithers/callback', type: 'POST',
    handler: async (req, res, runtime) => {
      const svc = runtime.getService<SmithersService>('smithers');
      // svc.ingestExternalEvent(req.body) → updates registry → emits MESSAGE_RECEIVED
      res.json({ ok: true });
    } },
  // optional: STATIC inspector UI (a small Vite app) served at /smithers
  // { name: 'smithers', path: '/smithers', type: 'STATIC', filePath: 'dist/frontend', public: true },
];
```

The `STATIC` + `public` route is exactly how Eliza plugins ship UI tabs — we could port a slim version of `pi-plugin`'s `RunInspector` here later.

### 5.6 Config — connection settings

Validate at `init`, read everywhere with `runtime.getSetting`. Declared for users in `package.json → agentConfig.pluginParameters` (see §8).

```ts
export const initSmithers: Plugin['init'] = async (_config, runtime) => {
  const url = runtime.getSetting('SMITHERS_URL') ?? 'http://127.0.0.1:7331';
  // SMITHERS_API_KEY is optional for a local gateway; required for a shared/remote one.
  runtime.logger.info(`[smithers] will connect to ${url}`);
};
```

---

## 6. The crux: bridging turn-based Eliza to long-running Smithers runs

Eliza is **request/response**; a Smithers run is **minutes-to-hours and stateful**. The plugin reconciles them with the three mechanisms the research calls out, wired to Smithers' real event stream:

1. **Kick off + immediate ack** — `RUN_SMITHERS_WORKFLOW`'s handler returns right away with a `HandlerCallback` line ("Launched … I'll report progress here"). It does **not** block on completion.
2. **Background streaming** — `SmithersService.watch(runId)` consumes `client.streamRunEvents({runId})` (Smithers' native SSE/WS) in the background. No polling needed (unlike the generic research skeleton's Task poller — Smithers pushes).
3. **Proactive re-entry** — on a *noteworthy* event (status change, approval needed, error, completion) the Service calls `runtime.emitEvent(EventType.MESSAGE_RECEIVED, { message, callback })`. `plugin-bootstrap` is subscribed to `MESSAGE_RECEIVED`, so it generates a fresh agent message into the originating room. The agent "speaks up" without the user prompting.

The event reducer turns Smithers frames into chat-worthy updates and keeps the registry current:

```ts
private reduce(run: TrackedRun, ev: any): { changed: boolean; message: string } {
  switch (ev?.type) {
    case 'run.status':                 // running → finished / failed / cancelled
      if (ev.status === run.status) return { changed: false, message: '' };
      run.status = ev.status;
      return { changed: true, message:
        ev.status === 'finished' ? `✅ Run \`${run.runId}\` (${run.workflow}) finished.`
        : ev.status === 'failed' ? `❌ Run \`${run.runId}\` failed: ${run.lastError ?? 'see logs'}.`
        : `Run \`${run.runId}\` is now ${ev.status}.` };
    case 'node.waiting-approval':      // human-in-the-loop gate
      run.pendingApprovals.push({ nodeId: ev.nodeId, prompt: ev.prompt });
      return { changed: true, message:
        `⚠️ Run \`${run.runId}\` needs your approval at **${ev.nodeId}**: ${ev.prompt ?? 'approve to continue?'}\n` +
        `Reply "approve" or "deny".` };
    case 'human.ask':                  // ask_human request inside a run
      return { changed: true, message: `🙋 The run is asking: ${ev.question}` };
    case 'node.error':
      run.lastError = String(ev.error);
      return { changed: true, message: '' };       // surfaced on next status update / provider
    default:
      return { changed: false, message: '' };
  }
}
```

> Event `type`/field names above are illustrative — wire them to Smithers' real frame schema (the `SmithersEvent` / devtools frame shapes in `packages/protocol` + `gateway`). The **pattern** — reduce stream → update registry → conditionally emit `MESSAGE_RECEIVED` — is the load-bearing part.

**Human-in-the-loop end-to-end:**
`run hits approval gate → Service emits MESSAGE_RECEIVED ("needs approval at deploy:confirm") → agent posts it → user replies "approve" → LLM picks APPROVE_SMITHERS_NODE → svc.approve(runId,nodeId) → Gateway resumes the run → next status event flows back`. This makes Smithers' approvals and `ask_human` feel like a normal chat — the single biggest UX win of going plugin-deep instead of agent-shallow.

---

## 7. The plugin object (assembled)

```ts
// src/plugin.ts
import type { Plugin } from '@elizaos/core';
import { SmithersService } from './service';
import { runWorkflowAction, checkRunAction, listRunsAction, approveAction, denyAction, cancelAction, answerHumanAction } from './actions';
import { smithersRunsProvider } from './providers';
import { runOutcomeEvaluator } from './evaluators';
import { smithersRoutes } from './routes';
import { initSmithers } from './config';

export const smithersPlugin: Plugin = {
  name: 'plugin-smithers',
  description: 'Drive the Smithers durable control plane from an ElizaOS agent: launch, watch, approve, and cancel workflow runs.',
  init: initSmithers,
  services: [SmithersService],
  actions: [runWorkflowAction, checkRunAction, listRunsAction, approveAction, denyAction, cancelAction, answerHumanAction],
  providers: [smithersRunsProvider],
  evaluators: [runOutcomeEvaluator],
  routes: smithersRoutes,
  dependencies: ['@elizaos/plugin-sql'],     // for the evaluator's memory writes
  // config: { ... static defaults stringified into init ... }
};

export default smithersPlugin;

// src/index.ts
export { smithersPlugin } from './plugin';
export default smithersPlugin;
```

A user enables it in their character:

```json
{
  "name": "Orchestrator",
  "plugins": ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap", "plugin-smithers"],
  "settings": {
    "SMITHERS_URL": "http://127.0.0.1:7331",
    "secrets": { "SMITHERS_API_KEY": "..." }
  }
}
```

---

## 8. Packaging & where it lives

**Recommendation: add `packages/eliza-plugin` to this monorepo** (mirrors `pi-plugin`), publish it to npm under a **non-`@elizaos/*`** name so Eliza users can install it.

- **Internal package name:** `@smithers-orchestrator/eliza-plugin` (consistent with `pi-plugin` = `@smithers-orchestrator/pi-plugin`).
- **Published/registry name:** the `@elizaos/*` scope is **reserved and rejected** by the registry validator, and `elizaos publish` wants a `plugin-*` prefix. So publish as **`@smithers-orchestrator/plugin-smithers`** (own scope is allowed) or unscoped **`elizaos-plugin-smithers`**. Discovery is keyword-based, so include `"keywords": ["elizaos", "plugin", "smithers", "orchestration"]`.
- **`@elizaos/core` placement:** `dependencies` (the current scaffold convention) — it's externalized by the bundler either way, never bundled into `dist/`.

`package.json` (note `agentConfig.pluginParameters` — how `elizaos plugins add` prompts the user for settings):

```json
{
  "name": "@smithers-orchestrator/eliza-plugin",
  "description": "Drive Smithers workflows from an ElizaOS agent",
  "version": "0.26.1",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "keywords": ["elizaos", "plugin", "smithers", "orchestration"],
  "exports": { ".": { "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } } },
  "files": ["dist", "README.md"],
  "dependencies": {
    "@elizaos/core": "^1.7.2",
    "@smithers-orchestrator/gateway-client": "workspace:*"
  },
  "devDependencies": { "tsup": "^8", "typescript": "~5.9.3", "vitest": "^4" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --external @elizaos/core",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "SMITHERS_URL":     { "type": "string", "description": "Smithers Gateway URL", "defaultValue": "http://127.0.0.1:7331" },
      "SMITHERS_API_KEY": { "type": "string", "description": "Smithers API key (required for a shared/remote gateway)" }
    }
  }
}
```

> **Caveat — `@smithers-orchestrator/gateway-client` as a `workspace:*` dep** works in-repo, but a *published* standalone plugin needs the gateway-client published to npm (it is, alongside `smithers-orchestrator`) — or switch the Service to the **`/v1` REST fallback** (§4) to drop the Smithers dependency entirely. Decide based on whether we publish from this monorepo or vendor the client.

**Build/test:** `tsup` ESM + `.d.ts`, `@elizaos/core` externalized; component tests under `vitest` plus an Eliza `TestSuite` registered on `plugin.tests` and run with `elizaos test --type e2e`.

---

## 9. Reuse what Smithers already ships

The plugin shouldn't reinvent things `pi-plugin` already proved out:

- **`@smithers-orchestrator/agents/agent-contract`** — `createSmithersAgentContract()` + `renderSmithersAgentPromptGuidance()` generate consistent "here's how to use Smithers' tools" guidance. Fold the rendered guidance into the `SMITHERS_RUNS` provider's `text` so the model gets the same playbook PI users get.
- **`docs/llms.txt` / `docs/llms-full.txt`** — ship/the agent can surface the concise bundle as on-demand context (pi-plugin's `/smithers-docs`).
- **`@smithers-orchestrator/gateway-client`** — the typed client; don't hand-roll WS framing.
- **`SmithersError`** (`@smithers-orchestrator/errors`) — consistent error shapes if we go in-monorepo.

---

## 10. Why not auto-generate Actions from the MCP tool surface?

`pi-plugin` mirrors **all 21 MCP tools** (`run_workflow`, `list_runs`, `watch_run`, `resolve_approval`, …) 1:1 into PI tools, because PI tools accept a typed JSON-Schema `parameters` object the model fills in. **Eliza v1.x Actions have no typed parameter schema** — the LLM only emits the action *name*; the handler must extract arguments itself (we use `useModel(OBJECT_SMALL)`). So a blind 1:1 MCP→Action mirror would produce 21 actions that all need bespoke extraction and would clutter selection.

**Decision:** hand-author ~7 **intent-shaped** actions (§5.2) that match how a person actually talks to an agent ("run the deploy", "approve it"), and keep MCP as **one optional escape hatch** action:

```ts
export const smithersToolAction: Action = {
  name: 'SMITHERS_TOOL',
  description: 'Call any low-level Smithers MCP tool by name (advanced/power-user escape hatch).',
  validate: async (rt) => !!rt.getService('smithers'),
  handler: async (rt, message, _s, _o, cb) => {
    const { tool, args } = await rt.useModel(ModelType.OBJECT_SMALL, { prompt: /* pick tool+args from message + tool list */ '' }) as any;
    const result = await rt.getService<SmithersService>('smithers')!.callMcpTool(tool, args); // optional MCP channel
    await cb?.({ text: result.text });
    return { success: !result.isError, data: { tool } };
  },
  examples: [],
};
```

When Eliza **v2** lands `Action.parameters` (see the Research tab's v2 deltas), revisit: at that point a generated 1:1 MCP mirror becomes attractive and we can converge with `pi-plugin`'s approach.

---

## 11. Testing (no-mocks, per repo policy)

The repo bans mocks; tests must hit a real backend. Plan:

- **Component tests (`vitest`, `src/__tests__/`):** import `smithersPlugin`, assert it wires the expected actions/providers/services; run each action's `handler` against a **real Smithers Gateway** seeded with a deterministic fixture workflow (a tiny `.smithers/workflows/echo` run). Assert the `HandlerCallback` text and `ActionResult`. This mirrors `pi-plugin/tests/*` which exercise the real `SmithersPiHttpClient` / lifecycle.
- **E2E (`TestSuite` on `plugin.tests`, `elizaos test --type e2e`):** boot a real `AgentRuntime` with the plugin + a real local Gateway; send "run the echo workflow", assert a run appears in `SMITHERS_RUNS`, drive an approval, assert completion is reported. Signal failure by throwing (the Eliza e2e contract).
- **CI note (repo rule):** CI has no agent CLIs/browsers — gate the e2e suite to spin up an in-process/local Gateway fixture (seeded, deterministic) and skip anything needing an external LLM, exactly like the existing `e2e/` suite seeds a fake agent.

---

## 12. Phased plan

| Phase | Deliverable | Notes |
|---|---|---|
| **0 — Scaffold** | `packages/eliza-plugin` with `Plugin`, empty `SmithersService`, `init` config validation, package.json `agentConfig`. | `elizaos create --type plugin` as a reference, then conform to monorepo conventions. |
| **1 — Read path** | `SmithersService` + `SMITHERS_RUNS` provider + `CHECK_/LIST_` actions over `SmithersGatewayClient`. | Agent can *observe* Smithers. Lowest risk. |
| **2 — Write path** | `RUN_SMITHERS_WORKFLOW` + background `streamRunEvents` → proactive `MESSAGE_RECEIVED`. | The core value: launch + auto-report. |
| **3 — Human-in-the-loop** | `APPROVE_/DENY_/ANSWER_HUMAN` actions + approval surfacing in the reducer. | Makes gates/`ask_human` conversational. |
| **4 — Polish** | `SMITHERS_RUN_OUTCOME` evaluator, `/smithers/*` routes, optional static inspector, `agent-contract` prompt guidance, docs + README. | |
| **5 — Publish** | Decide name (`@smithers-orchestrator/plugin-smithers` vs `elizaos-plugin-smithers`), publish, optional registry PR. | Keep maintained at source (this monorepo). |

---

## 13. Decisions I need from you

1. **Transport** — go with typed `SmithersGatewayClient` (recommended), or the zero-dep `/v1` REST fallback for a fully standalone publishable plugin?
2. **Home** — `packages/eliza-plugin` in this monorepo (recommended; maintained at source), or a separate repo?
3. **Published name** — `@smithers-orchestrator/plugin-smithers` (own scope) or unscoped `elizaos-plugin-smithers` for maximum `elizaos plugins add` ergonomics?
4. **Scope of v1** — read+write+approvals (Phases 1–3), or start read-only (Phase 1) to de-risk?
5. **Proactive messaging** — is emitting synthetic `MESSAGE_RECEIVED` to make the agent "speak up" desirable, or should run updates be pull-only (agent reports only when asked)? (Affects whether we background-stream.)

---

## 14. How this complements `agent-eliza`

With both packages installed you get a **bidirectional bridge**:

- **Smithers → Eliza** (`agent-eliza`): a Smithers `<Task agent={new ElizaAgent({character})}>` uses an Eliza character as a model/persona backend inside a workflow.
- **Eliza → Smithers** (`plugin-smithers`): an Eliza agent uses Smithers as its durable execution substrate for anything long-running.

That makes Smithers and Eliza first-class peers rather than one-way adapters — an Eliza persona can *orchestrate* durable work, and durable work can *delegate* to an Eliza persona. It also gives us a clean story for the docs: "Smithers speaks Eliza both ways."
