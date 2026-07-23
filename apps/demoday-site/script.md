# Read-aloud script — Smithers demo day (3:00 hard limit)

This script IS the deck's speaker notes: the lines below live in `src/slides.ts`
(section `notes`) and are the single source of truth. The TTS narration in
`public/narration/` was generated from them with OpenAI `gpt-4o-mini-tts` (voice
`ash`) via `bun scripts/narrate.ts`, and the full read measures **2:59.9** — the
clock marks below are the real measured start times, not estimates.

How to run the deck: `pnpm -C apps/demoday-site dev` → open the URL. **→ / space**
advances, **←** goes back, **N** shows these lines as speaker notes on screen,
**P** plays the TTS narration and auto-advances the deck in sync (rehearsal mode),
**T** starts the 3:00 countdown, **F** fullscreen. The deck is 17 steps: slides
5–8 are one visual advancing through the vibe-audit story (terminal ask → the
React source → the agent-built control room → the quota-park recovery).

---

**[STEP 1 — title · 0:00]**

> Hi, I'm Will, creator of Smithers. Smithers makes agent workflows you can
> trust — they finish, survive crashes, and wait for sign-off.

*(advance → 0:11)*

**[STEP 2 — traction · 0:11]**

> Launched in January, open source. Forty community projects build on Smithers;
> four hundred fifty in our Telegram. And users don't churn.

*(advance → 0:22)*

**[STEP 3 — problem · 0:22]**

> Everyone can describe a workflow they want. Making it real — and keeping it
> alive — is the hard part. The plumbing is more work than the idea.

*(advance → 0:33)*

**[STEP 4 — solution · 0:33]**

> Smithers ships the plumbing as the framework — durability, retries, approvals,
> observability built in. You just describe the job.

*(advance → 0:43)*

**[STEP 5 — live · ask · 0:43]**

> In my terminal, I ask for a security review like vibeaudit — strategies in
> parallel, dedupe, triage, one report. A real example, built on Smithers.

*(advance → 0:56)*

**[STEP 6 — live · code · 0:56]**

> That's the workflow it wrote — real source, and it's React. Agents one-shot
> these workflows because they already know React deeply.

*(advance → 1:06)*

**[STEP 7 — live · UI · 1:06]**

> And it built this — a live control room from Smithers components. Strategies
> streaming in parallel, findings deduped and triaged as they land.

*(advance → 1:17)*

**[STEP 8 — live · recover · 1:17]**

> Now watch the dependency audit — it hits a rate limit. Smithers parks it,
> costing nothing, retries on a fallback agent, and finishes. Nothing lost.

*(advance → 1:28)*

**[STEP 9 — one-way data flow · 1:28]**

> Under the hood: one-way data flow. Events update state; the plan is a pure
> function of state. Time travel, resume, and SQL debug come for free.

*(advance → 1:41)*

**[STEP 10 — built on Smithers · 1:41]**

> Real products ship on Smithers — Aomi ships production apps from a single
> prompt. The next Harvey, the next CodeRabbit: built on agents they can trust.

*(advance → 1:53)*

**[STEP 11 — why we win · 1:53]**

> Building agents shifts like a game meta — a new patch drops, everyone re-
> learns, but the engine stays. Every model release makes Smithers stronger.

*(advance → 2:04)*

**[STEP 12 — custom-fitted · 2:04]**

> Other orchestrators are one-size-fits-all: you bend the job to fit the tool.
> Smithers is custom-fitted to every job.

*(advance → 2:13)*

**[STEP 13 — rails · 2:13]**

> Smithers is the Ruby on Rails of workflow automation.

*(advance → 2:19 — let the line sit for a beat)*

**[STEP 14 — market · 2:19]**

> Workflow automation was giant before agents. After agents it gets bigger —
> everyone's asking to start.

*(advance → 2:27)*

**[STEP 15 — business model · 2:27]**

> Smithers is free — that's distribution; the canonical open-source engine is
> the moat. Revenue is cloud, plus the enterprise last mile.

*(advance → 2:38)*

**[STEP 16 — team · 2:38]**

> In twenty twenty-five I built the fastest open-source Ethereum VM with agents.
> Tevm, the OP Stack, now Smithers.

*(advance → 2:47)*

**[STEP 17 — the ask · 2:47]**

> We're looking for angels and design partners — I'll work hands-on to integrate
> Smithers into your product or back office. Smithers makes agent workflows
> reliable. Come find me.

*(end · 3:00)*

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
- If the timer shows red (< 20s) and you're not on step 16 yet, jump straight to
  the ask — it's self-contained.
