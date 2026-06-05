# Proposal: `UltraGrill` (Real-Time Collaboration) workflow

> Name: **UltraGrill** (id `ultra-grill`) — the real-time, parallel,
> voice-driven evolution of `grill-me`.

Status: **V1 BUILT (2026-06-03).** The product ships as `ultragrill` —
`.smithers/workflows/ultragrill.tsx` + `.smithers/ui/ultragrill.tsx`, e2e-tested
end to end against a real gateway + browser (`.smithers/tests/ultragrill.e2e.test.ts`).
What's live: the durable open-ended session (intake `<Loop>` of
`<WaitForEvent>` fed by `utterance` signals + `end` to finish — D8), dynamic
worker dispatch with a living markdown artifact (D7), and a rolling question
pool surfaced from worker output. **Follow-ons** (deliberately not in v1, because
the proposal's own #1 risk — interleaving many async durable waits in a
never-ending run — is real): voice transcription (D1), the dev-server iframe
(D5), and the durable-`<HumanTask>`-with-TTL question pool (D6). v1 keeps a
single durable wait in flight so the run cycles deterministically.

Decision log below captures every choice from the question rounds.

## Decision log

| # | Decision | Choice |
|---|----------|--------|
| D1 | Voice / transcription | **Pluggable transcription interface as a reusable gateway capability.** Cloud backend (OpenAI/Deepgram) is the built-in default; local `whisper.cpp` ships as a **separate importable package**. Exposed to UIs as a shared `useTranscription` hook. |
| D2 | Worker isolation | **None.** Shared repo, workers edit in parallel and may collide; collisions are visible in the feed and fixed live. One workspace → one dev server → one preview. |
| D3 | Fan-out | **The intake (talk-plane) agent decides** when to split a request into parallel workers. |
| D4 | `write-a-prd` | **Deleted outright.** `ultra-grill` is the only path. |
| D5 | Dev server / live preview | **Reusable gateway capability** ("managed process + iframe preview + restart"), like transcription. `ultra-grill` is its first consumer. |
| D6 | Question pool | **Fixed 5 slots, ~90s TTL.** Unanswered → expire → slot regenerates a fresh question. |
| D7 | Artifacts / "the PRD" | **No fixed single output, no approval gate.** The worker can create **any number of living documents/artifacts**, **markdown-first**, **HTML-renderable**. Continuously updated, always exportable. |
| D8 | Run lifecycle | **Runs open-ended until the user sends an `end` signal.** Run + view state is **reflected in the URL** (URL-as-state). |

Everything marked **OPEN** below is a decision I'm deliberately leaving for you.

---

## 1. What this is

A long-lived, voice-driven Smithers workflow for **collaborating with agents in
real time while they build** — primarily to iterate on a UI you can watch running
on a dev server. You talk; a worker (which can fan out into several parallel
workers) does the work; you watch its chat + tool calls stream by; and the agent
keeps a *rolling pool of clarifying questions* in front of you that you can answer
or ignore, with stale ones aging out and being replaced automatically.

It is a **standard, general-purpose workflow** meant to **replace one-shot
"interview me then produce a doc" workflows** — starting with `write-a-prd`
(`.smithers/workflows/write-a-prd.tsx`) and the same family (`grill-me`, `plan`,
`mission`'s intake). Instead of *grill → freeze a PRD*, collaboration is
*continuous*: you converse, work happens live, and the spec/PRD is just a
**living output the worker keeps in sync** — a byproduct, not the goal.

Name / id: **`ultra-grill`** (display: "UltraGrill").

---

## 2. The mental model: two planes

The hard part of "real-time collaboration" is that talking is *fast* and building
is *slow*. So the workflow is split into two concurrent planes that never block
each other:

```
┌── CONVERSATION PLANE (fast, cheap model) ──────────────────────────┐
│  voice/text in → intake agent → { directives → worker queue }      │
│                                 { questions  → question pool  }     │
└────────────────────────────────────────────────────────────────────┘
            │ directives                       ▲ answers
            ▼                                  │
┌── WORKER PLANE (slow, smart model, parallel) ──────────────────────┐
│  Parallel workers drain the directive queue, edit UI code,         │
│  drive the dev server, and keep the living spec in sync.           │
│  Every chat msg + tool call streams to the UI feed.                │
└────────────────────────────────────────────────────────────────────┘
            │ controls
            ▼
┌── DEV SERVER (managed background process) ─────────────────────────┐
│  `pnpm dev` kept alive for the run; start/restart via UI buttons.  │
│  Rendered in an iframe so you see the live UI as it changes.        │
└────────────────────────────────────────────────────────────────────┘
```

Everything is one durable run. The two planes communicate through **durable
queues** held in run state (the same trick `dynamic-demo.tsx` uses to grow/shrink
its task tree each frame).

---

## 3. The UI (this is mostly net-new)

A custom workflow UI, shipped the way every other workflow UI is — a React app
emitted to `.smithers/ui/ultra-grill.tsx`, built from `gateway-react` hooks
(`useGatewayRuns`, `useGatewayRunEvents`, `useGatewayNodeOutput`,
`useGatewayActions`), served by the gateway, opened with `smithers ui`. Four
regions:

```
┌───────────────────────────────┬──────────────────────────────┐
│  ② QUESTION POOL (≤5)          │                              │
│  ┌─────────────────────────┐  │   ④ LIVE DEV-SERVER PREVIEW   │
│  │ Q: tabs or cards?  ⏳28s │  │   (iframe → localhost:5173)  │
│  │ [recommend: tabs] answer │  │                              │
│  ├─────────────────────────┤  │   [▶ start] [⟳ restart]      │
│  │ Q: dark mode default?    │  │                              │
│  │ … up to 5, each w/ TTL   │  │                              │
│  └─────────────────────────┘  │                              │
├───────────────────────────────┤                              │
│  ③ WORKER FEED                 │                              │
│  [All ▾] [worker:nav] [worker:form]   ← agent filter chips   │
│  09:12 worker:nav  💬 "moving the tabs into a sidebar…"      │
│  09:12 worker:nav  🔧 edit  src/Nav.tsx                      │
│  09:13 worker:form 🔧 bash  pnpm test                        │
│  … merged interleaved stream, filterable per agent           │
├───────────────────────────────────────────────────────────────┤
│  ① VOICE COMPOSER   🎙 [hold to talk]  ▒▒▒▓▓▒ "make the…"     │
└───────────────────────────────────────────────────────────────┘
```

**① Voice composer.** No audio/STT exists anywhere in the repo today — net-new,
built as a **reusable gateway transcription capability** (D1). `MediaRecorder`
streams mic audio to the gateway; partial transcripts return over the websocket
and show live; on finalize the utterance is posted to the run as a signal. The
backend is pluggable — **cloud (OpenAI/Deepgram) is the default**, **local
`whisper.cpp` is a separate importable package**. UIs consume it via a shared
`useTranscription` hook. Text input is always available as a fallback.

**② Question pool.** Up to 5 open questions, each a durable `<HumanTask>` with a
TTL. The card shows the question, the agent's recommended answer (one click to
accept), and a countdown. Answer it, ignore it, or let it expire — expired/answered
cards are removed and the slot regenerates a fresh, now-better-informed question
**asynchronously** (§4.3). The UI reads pending questions from the gateway's
human-request API and submits answers back through it — real backend, no polling
fabrication.

**③ Worker feed.** The live stream of the worker plane — chat messages and tool
calls — from `useGatewayRunEvents`. When the worker fans out, each parallel worker
is a distinct `nodeId` (`worker:<slug>`). The feed defaults to a **merged,
interleaved** view (ordered by event `seq`) with **per-agent filter chips**
derived from the run's DevTools node tree, so you can watch one worker or all of
them at once — exactly the "switch between agents or see them mixed" UX you asked
for.

**④ Live preview.** The dev server in an `iframe` (the overlay type already
exists in studio), with Start/Restart buttons wired to a signal (§4.4).

---

## 4. The workflow (`ultra-grill.tsx`) — grounded in existing primitives

A single durable run with a top-level keep-alive `<Loop until={false}>`. Each
frame re-renders the whole tree from durable state — so to "dispatch new tasks as
the user asks," we just read a durable queue and `.map()` it into tasks, the way
`dynamic-demo` does. Sketch:

```tsx
<Workflow name="ultra-grill">
  <Parallel>                          {/* the planes run concurrently */}

    {/* ── plane A: intake ───────────────────────────── */}
    <Loop id="intake" until={false}>
      {/* drain the user-utterance inbox (signals from the UI),
          classify each: → directive queue, or → seed a question */}
      <Task id="intake:turn" agent={agents.cheapFast} output={outputs.routed}>
        <IntakePrompt utterances={ctx.pendingUtterances()} state={designState} />
      </Task>
    </Loop>

    {/* ── plane B: workers (dynamic fan-out) ─────────── */}
    <Parallel maxConcurrency={ctx.input.maxWorkers ?? 3}>
      {ctx.openDirectives().map((d) => (
        <Task key={d.id} id={`worker:${d.slug}`} agent={agents.smart}
              output={outputs.workItem}>
          <WorkerPrompt directive={d} devServer={devUrl} spec={designState} />
        </Task>
      ))}
    </Parallel>

    {/* ── plane C: rolling question pool (≤5 slots) ──── */}
    <Parallel maxConcurrency={5}>
      {[0,1,2,3,4].map((slot) => (
        <Loop key={slot} id={`q:${slot}`} until={false}>
          <Sequence>
            <Task id={`q:${slot}:gen`} agent={agents.cheapFast}
                  output={outputs.question}>
              <GenerateQuestionPrompt state={designState} alreadyAsked={asked} />
            </Task>
            <HumanTask id={`q:${slot}:ask`} async timeoutMs={ctx.input.questionTtlMs ?? 90_000}
                       output={outputs.answer} prompt={/* generated question */} />
            {/* answered → fold into designState; expired → discard; loop regenerates */}
          </Sequence>
        </Loop>
      ))}
    </Parallel>

    {/* ── plane D: dev-server controller ─────────────── */}
    <DevServer id="dev" command={ctx.input.devCommand ?? "pnpm dev"} />

  </Parallel>
</Workflow>
```

### 4.1 Dispatching tasks from speech
The UI posts each finalized utterance as a **signal** (`submitSignal`). The intake
loop drains them, and the cheap intake agent classifies each utterance into either
a **directive** (appended to a durable directive queue → becomes a worker task next
frame) or a **clarifying question seed**. This is the same conditional-JSX dynamic
dispatch proven in `dynamic-demo.tsx`.

### 4.2 Parallel workers + per-agent feed
Workers run under `<Parallel>` with stable `nodeId`s, so the event stream is
already keyed by agent. The UI's filter chips and merged view are pure client-side
reads of that stream — no engine change needed.

### 4.3 The rolling 5-question pool — the novel bit
Each of the 5 slots is an independent `<Loop>` of *generate → ask(async, TTL) →
fold/discard → repeat*. Because the `<HumanTask>` is **`async`** with a
**`timeoutMs`**, an unanswered question hits **`expired`** status (a real engine
status: `pending | answered | cancelled | expired`) and the slot immediately loops
to generate a replacement — informed by everything learned since. Five slots → ~5
live questions at all times, self-refreshing, never blocking the other planes.
This reuses the durable human-request machinery rather than the ad-hoc
`scripts/ask-user.ts` file poller, so it survives restarts and shows up in the
gateway like every other approval/question.

### 4.4 Dev-server lifecycle
A `<DevServer>` component (new, small) starts `pnpm dev` as a **detached
background process** keyed to the run, writes its URL into run state for the
iframe, and listens on a `<Signal id="dev:restart">`. The UI's Restart button
fires that signal → kill + respawn. **OPEN:** how we own a never-exiting process
inside a durable run (see §6, risk #1).

### 4.5 Living artifacts (what replaces `write-a-prd`)
There is no single fixed output and no approval gate (D7). The worker maintains
**any number of living documents/artifacts** — **markdown-first, HTML-renderable** —
keeping them current as decisions land (from answers + directives). At any point an
artifact *is* the PRD/spec: exportable, diffable, never a one-shot dead end. This is
why `write-a-prd` is simply deleted (D4) — UltraGrill subsumes it.

---

## 5. Build phases (rough)

1. **Skeleton workflow** — two planes, text-only intake via signals, single
   worker, no UI. Prove dynamic dispatch + the async question pool against the
   real engine.
2. **Custom UI** — feed with per-agent filters, question pool cards, dev-server
   iframe + restart. Wire to gateway-react hooks.
3. **Voice** — Web Speech API composer with live partials + text fallback.
4. **Parallel workers + living spec** — fan-out, merged/filtered feed, spec output.
5. **Delete `write-a-prd`** — remove the workflow + its UI/screenshot/docs (D4).

---

## 6. Risks / things I most want your steer on

1. **Never-ending durable run.** Smithers is built around durable, bounded,
   deterministic frames; an open-ended real-time run with live queues pushes on
   `continueAsNewEvery` checkpointing and on how `async` tasks interleave with
   re-renders. **This is the #1 thing to validate with a spike** before we commit
   to the architecture.
2. **Owning a long-lived dev-server process** inside a run that's designed to
   suspend/resume — needs a clear owner (gateway-managed PTY? detached pid we
   adopt?).
3. **Transport latency.** Workflow UIs stream over the gateway websocket (good);
   studio's surface still polls at 2s (too slow for this). We'd standardize on the
   ws event stream.
4. **Voice quality vs. infra** — the §3① open question.

## 7. Remaining implementation detail (not blocking)

All product decisions are made (see decision log). What's left is detail to settle
during build:

- **Intake routing** — how the talk-plane agent classifies an utterance into
  *directive* vs *question seed* vs *fan-out* (a prompt + small schema; the agent
  decides per D3).
- **End-signal UX** — the UI "end session" control posts the `end` signal (D8);
  confirm whether ending drains in-flight workers gracefully or hard-stops.
- **Transcription interface shape** — the exact `Transcriber` interface both the
  cloud default and the local `whisper.cpp` package implement (D1).
- **Dev-server capability surface** — the gateway API for start/restart/URL/preview
  that `ultra-grill` consumes (D5).
- **Artifact rendering** — where the worker's markdown/HTML artifacts surface in
  the UI (a panel? the overlay system?) and how they're listed/exported (D7).
- **Name/id** — still `ultra-grill`? (only naming is open.)
```

