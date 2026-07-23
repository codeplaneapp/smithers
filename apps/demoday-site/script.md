# Read-aloud script — Smithers demo day (3:00 hard limit)

This script IS the deck's speaker notes: the lines below live in `src/slides.ts`
(section `notes`) and are the single source of truth. The TTS narration in
`public/narration/` was generated from them with OpenAI `gpt-4o-mini-tts` (voice
`ash`) via `bun scripts/narrate.ts`, and the full read measures **2:59.7** — the
clock marks below are the real measured start times, not estimates.

How to run the deck: `pnpm -C apps/demoday-site dev` → open the URL. **→ / space**
advances, **←** goes back, **N** shows these lines as speaker notes on screen,
**P** plays the TTS narration and auto-advances the deck in sync (rehearsal mode),
**T** starts the 3:00 countdown, **F** fullscreen. The deck is 16 steps: slides
5–8 are one visual advancing through the vibe-audit story (terminal ask → the
React source → the agent-built control room → the quota-park recovery).

---

**[STEP 1 — title · 0:00]**

> Hey everyone, I'm Will also known as fucory,
> Creator of Smithers. I have spent everyday for almost a year now
> obsessing over agentic workflows

_(advance → 0:11)_

**[STEP 2 — traction · 0:11]**

> Most users quietely churn when they encounter bugs early in a project.
> Smithers users write multiparagraph open letters to the maintainer because
> They love smithers and desperately want it to succeed

_(advance → 0:24)_

**[STEP 3 — problem · 0:24]**

> Building workflows is hard
> Users trust smithers because it's dependable

_(advance → 0:31)_

**[STEP 4 — solution · 0:31]**

> Smithers ships the plumbing as the framework — durability, retries, approvals,
> observability built in. You just describe the job.

_(advance → 0:41)_

**[STEP 5 — live · ask · 0:41]**

> In my terminal, I ask for a security review like vibeaudit — strategies in
> parallel, dedupe, triage, one report. A real example, built on Smithers.

_(advance → 0:54)_

**[STEP 6 — live · code · 0:54]**

> That's the workflow it wrote — real source, and it's React. Agents one-shot
> these workflows because they already know React deeply.

_(advance → 1:05)_

**[STEP 7 — live · UI · 1:05]**

> And it built this — a live control room from Smithers components. Strategies
> streaming in parallel, findings deduped and triaged as they land.

_(advance → 1:15)_

**[STEP 8 — live · recover · 1:15]**

> Now watch the dependency audit — it hits a rate limit. Smithers parks it,
> costing nothing, retries on a fallback agent, and finishes. Nothing lost.

_(advance → 1:27)_

**[STEP 9 — one-way data flow · 1:27]**

> Under the hood: one-way data flow. Events update state; the plan is a pure
> function of state. Time travel, resume, and SQL debug come for free.

_(advance → 1:39)_

**[STEP 10 — built on Smithers · 1:39]**

> Real products ship on Smithers — Aomi ships trading strategies from one
> prompt. The next Harvey, the next CodeRabbit: built on agents they can trust.

_(advance → 1:51)_

**[STEP 11 — why we win · 1:51]**

> Building agents shifts like a game meta — a new patch drops, everyone re-
> learns, but the engine stays. Every model release makes Smithers stronger.
> And other orchestrators are one-size-fits-all — you bend the job to fit the
> tool. Smithers is custom-fitted to every job.

_(advance → 2:11)_

**[STEP 12 — market · 2:11]**

> Workflow automation was giant before agents. After agents it gets bigger —
> everyone's asking to start.

_(advance → 2:20)_

**[STEP 13 — rails · 2:20]**

> Smithers is the Ruby on Rails of workflow automation.

_(advance → 2:24 — let the line sit for a beat)_

**[STEP 14 — business model · 2:24]**

> Smithers is free — that's distribution; the canonical open-source engine is
> the moat. Revenue is cloud, plus the enterprise last mile.

_(advance → 2:36)_

**[STEP 15 — team · 2:36]**

> In twenty twenty-five I built the fastest open-source Ethereum VM with agents.
> Tevm, the OP Stack, now Smithers.

_(advance → 2:47)_

**[STEP 16 — the ask · 2:47]**

> We're looking for angels and design partners — I'll work hands-on to integrate
> Smithers into your product or back office. Smithers makes agent workflows
> reliable. Come find me.

_(end · 3:00)_

---

## Delivery notes

- The opening sells trust with no numbers; traction lands on step 2 before any
  category language.
- The live section (5–8) is the vibeaudit story: a real community-style ask in
  the terminal, the real React source, the control room the agent built from
  Smithers components, and the rate-limit park + fallback-agent recovery — all
  captured from real runs. The React point lives on the CODE beat now, not the
  solution slide.
- Step 8 (recover) is the money moment: "parks it, costing nothing" lands while
  the amber parked badge is on screen.
- Step 13 (rails) is a one-liner: say it, let it breathe for a beat.
- The one-liner is the last thing they hear — hit "reliable".
- Rehearse against the TTS: press **P** and shadow-read; if you consistently beat
  the voice to the next slide, you're at pace.
- If the timer shows red (< 20s) and you're not on step 15 yet, jump straight to
  the ask — it's self-contained.
