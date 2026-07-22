# Smithers demo-day pitch — draft v1 (~420 words ≈ 2:50 spoken)

## 1. What you do (~26 words)

> Hi, I'm Will. Smithers makes AI agents reliable — they can work for days, survive
> crashes, and wait overnight for human sign-off without ever losing work.

SHOW: logo + "AI agents that never lose work."

## 2. Problem (~52 words)

> Everyone wants AI to actually do the work. But agents live in chat windows. The laptop
> closes, a rate limit hits, a step needs a manager's approval — and the work dies. So
> you babysit them. The AI got good. The plumbing to run it like a business never got
> built.

SHOW: "The AI got good. The plumbing didn't."

## 3. Solution (~66 words)

> Smithers runs agents as durable workflows. Every finished step is saved the moment it
> completes — kill the process mid-run, it resumes exactly where it stopped. A human
> approval pauses the run as a database row — costs nothing — until you answer, tomorrow
> if needed. It's open source and agent-agnostic: Claude, Codex, Gemini, mixed in one
> workflow. And you don't write workflows — you describe the job, your agent builds it.

SHOW: 10-second loop of a run being killed mid-flight and resuming with zero lost steps.

## 4. Traction (~64 words)

> We launched in January, open source. Last thirty days: twenty-one thousand downloads —
> two-point-two times month over month, and accelerating. Fifteen-plus outside
> contributors. People we've never met run Smithers in production Kubernetes clusters and
> build their own products on the engine. Non-technical users keep asking us, unprompted,
> to replace Zapier. And we're in early conversations with Opendoor about onboarding
> their org.

SHOW: the downloads growth chart. Big number: "21,001 last 30 days · 2.2× MoM."
⚠️ Numbers dated Jun 2026 — repull npm/stars/Opendoor status before recording.

## 5. Insight / why you win (~58 words)

> Here's what we figured out: the right way to build agents changes every six months —
> but the layer underneath, durable orchestration, never changes. We built that layer out
> of React, the one language every model already writes fluently, so agents author their
> own workflows. Anthropic just shipped a closed, Claude-only copy. Validation. The open,
> any-model layer wins — like Linux won.

SHOW: three-layer stack; bottom layer highlighted: "the layer that doesn't change."

## 6. Market (~38 words)

> [PLACEHOLDER — needs research] Workflow automation is a $__B market — Zapier, UiPath,
> Temporal each built on a slice of it. Every one of those processes is becoming an agent
> workflow, and every agent workflow needs this layer.

SHOW: one number: "$__B workflow automation → all of it becomes agent workflows."

## 7. Business model (~25 words)

> The engine is free — that's our distribution. The cloud is forty to two hundred dollars
> a month. The real revenue is enterprise: governance, audit, on-prem.

SHOW: "Free engine → $40–200/mo cloud → enterprise governance."

## 8. Team (~33 words)

> I'm a solo founder, ex-Google. I built the fastest Ethereum VM in existence — beating
> the previous best from a world-class team — using AI agents. Smithers is how I did it,
> productized.

SHOW: face + "Ex-Google · fastest EVM ever · built with agents."

## 9. The ask (~35 words)

> We're raising [$___] to [milestone 1] and [milestone 2]. Smithers makes AI agents
> reliable — they work for days and never lose work. If you think agents are the next
> workforce, come talk to me.

SHOW: "Raising $___ · will@tevm.tech"
⚠️ Amount + milestones don't exist anywhere yet — founder decision required.

---

## Judgment calls made in this draft (challenge any of them)

1. **Dev-first story, SMB as a signal.** Traction is developer traction, so the pitch
   leads there; the Zapier line and Opendoor carry the "this expands beyond devs" hint
   without betting the pitch on it.
2. **Crash-resume is the magic moment** and lives inside Solution — it's the single most
   visual, ownable claim.
3. **Insight slide does triple duty**: layer thesis + React/agents-author-workflows +
   Anthropic validation, because at demo day "competition" collapses into "why we win."
4. **One-liner v1: "Smithers makes AI agents reliable."** Repeated verbatim in the close.
   Alternatives to test: "agents that never lose work" / "the reliability layer for AI
   agents" / "run AI agents like production systems, not chat windows."

## Open holes (can't be filled from existing materials)

- Market number ($__B) — needs a defensible source.
- Ask amount + the 2–3 milestones it buys.
- Traction refresh (numbers are ~6 weeks old).
- Verify the SWE-EVO/RoadmapBench benchmarks shipped publicly before citing them anywhere.
