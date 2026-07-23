# Read-aloud script — Smithers demo day (3:00 hard limit)

This script IS the deck's speaker notes: the lines below live in `src/slides.ts`
(section `notes`) and are the single source of truth. The TTS narration in
`public/narration/` was generated from them with OpenAI `gpt-4o-mini-tts` (voice
`ash`) via `bun scripts/narrate.ts`, and the full read measures **2:58.9** — the
clock marks below are the real measured start times, not estimates.

How to run the deck: `pnpm -C apps/demoday-site dev` → open the URL. **→ / space**
advances, **←** goes back, **N** shows these lines as speaker notes on screen,
**P** plays the TTS narration and auto-advances the deck in sync (rehearsal mode),
**T** starts the 3:00 countdown, **F** fullscreen. The deck is 15 steps: slides
5–7 are one visual that advances through the sales-pipeline run's three beats.

---

**[STEP 1 — title · 0:00]**

> Hi, I'm Will, the creator of Smithers. Smithers runs agent workflows you can
> trust — jobs that finish, survive crashes, and wait for human sign-off.

*(advance → 0:11)*

**[STEP 2 — traction · 0:11]**

> We launched in January, open source. Today, forty community projects build on
> Smithers, and four hundred fifty people are active in our Telegram. And users
> don't churn — they report bugs and stay.

*(advance → 0:25)*

**[STEP 3 — problem · 0:25]**

> Everyone can describe a workflow they want automated. Making it real is the
> hard part: authoring, monitoring, approvals, cleanup after every crash. The
> plumbing is more work than the idea.

*(advance → 0:39)*

**[STEP 4 — solution · 0:39]**

> Smithers ships the plumbing as the framework — durability, retries, approvals,
> observability, built in. You don't write the workflows: you simply describe the
> job. Agents one-shot these workflows because it's React, which they already
> know.

*(advance → 0:55 — the sales-pipeline run begins; each line lands on its own gif)*

**[STEP 5 — live · describe · 0:55]**

> Here's what that looks like: I describe the pipeline in chat — score my inbound
> leads, draft outreach, nothing sends without my sign-off.

*(advance → 1:05)*

**[STEP 6 — live · build · 1:05]**

> My agent authors the workflow — real source: enrich, score, draft, an approval
> gate; I never wrote a line. And it self-improves: every run is scored, and the
> prompts re-optimize weekly.

*(advance → 1:18)*

**[STEP 7 — live · run · 1:18]**

> It runs, every step streaming — leads enriched and scored, outreach held at my
> gate — and I can time-travel back to any point.

*(advance → 1:29)*

**[STEP 8 — people · 1:29]**

> And not just agents — Smithers orchestrates people too: approvals, durable
> steps, and live collaboration, like a Google Doc.

*(advance → 1:40)*

**[STEP 9 — built on Smithers · 1:40]**

> Real products ship on Smithers — Aomi ships production apps from a single
> prompt. The next Harvey, the next CodeRabbit: built on agents they can trust.

*(advance → 1:52)*

**[STEP 10 — why we win · 1:52]**

> Building agents shifts like a video-game meta: a new patch drops, everyone
> re-learns — but the engine stays. Smithers plugs into every agent, so every
> model release makes it stronger.

*(advance → 2:05)*

**[STEP 11 — rails · 2:05]**

> Smithers is the Ruby on Rails of workflow automation.

*(advance → 2:10 — let the line sit for a beat before advancing)*

**[STEP 12 — market · 2:10]**

> Workflow automation was giant before agents. After agents it gets bigger —
> companies that never automated anything are asking to start.

*(advance → 2:21)*

**[STEP 13 — business model · 2:21]**

> Smithers is free — that's distribution, and the canonical open-source engine is
> the moat. Revenue is the cloud that runs these workflows, plus the enterprise
> last mile.

*(advance → 2:34)*

**[STEP 14 — team · 2:34]**

> In twenty twenty-five I built the fastest open-source Ethereum VM — with
> agents. Tevm, the OP Stack, now Smithers.

*(advance → 2:46)*

**[STEP 15 — the ask · 2:46]**

> We're looking for angels and design partners — I'll work hands-on to integrate
> Smithers into your product or back office. Smithers makes agent workflows
> reliable. Come find me.

*(end · 2:59)*

---

## Delivery notes

- The opening sells trust and outcomes with no numbers; the traction numbers (40
  community projects, 450 in Telegram) land on step 2 — before any category
  language, so the first impression is users and outcomes, not "workflow
  orchestration".
- The live run (5–7) is the sales-pipeline story: a business workflow with lead
  SCORING, not a coding demo. The approval gate lives in the workflow source and
  the run gif (the "Approval needed: send outreach" hold) — the narration sells
  it without a dedicated slide.
- Step 11 (rails) is a one-liner slide: say it, then let it breathe for a beat.
- The one-liner is the last thing they hear — hit "reliable".
- Numbers land better slightly slower: "*forty* community projects… *four
  hundred fifty*."
- Rehearse against the TTS: press **P** and shadow-read; if you consistently beat
  the voice to the next slide, you're at pace.
- If the timer shows red (< 20s) and you're not on step 14 yet, jump straight to
  the ask — it's self-contained.
