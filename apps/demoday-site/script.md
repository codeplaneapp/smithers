# Read-aloud script — Smithers demo day (3:00 hard limit)

This script IS the deck's speaker notes: the lines below live in `src/slides.ts`
(section `notes`) and are the single source of truth. The TTS narration in
`public/narration/` was generated from them with OpenAI `gpt-4o-mini-tts` (voice
`ash`) via `bun scripts/narrate.ts`, and the full read measures **2:59.7** — the
clock marks below are the real measured start times, not estimates.

How to run the deck: `pnpm -C apps/demoday-site dev` → open the URL. **→ / space**
advances, **←** goes back, **N** shows these lines as speaker notes on screen,
**P** plays the TTS narration and auto-advances the deck in sync (rehearsal mode),
**T** starts the 3:00 countdown, **F** fullscreen. The deck is 14 steps: slides
5–9 are one visual that advances through five beats — keep talking, keep tapping.

If you're behind a mark, the two [CUT IF OVER] lines buy back ~8 seconds.

---

**[STEP 1 — title · 0:00]**

> Hi, I'm Will, the creator of Smithers. Last month alone, Smithers was downloaded
> ninety-seven thousand times — agent workflows people actually trust: jobs that
> finish, survive crashes, and wait for human sign-off.

*(advance → 0:16)*

**[STEP 2 — traction · 0:16]**

> We launched in January, open source, and we've grown every month since. And users
> don't churn: they report bugs and stay, calling Smithers one of the biggest
> unlocks in their agentic toolkit.

*(advance → 0:32)*

**[STEP 3 — problem · 0:32]**

> Here's the problem. Everyone can describe a workflow they want automated. Making
> it real is the hard part: authoring, monitoring, approvals, cleanup after every
> crash. The plumbing is more work than the idea.

*(advance → 0:48)*

**[STEP 4 — solution · 0:48]**

> Smithers ships the plumbing as the framework — durability, retries, approvals,
> observability, built in. You don't write the workflows: describe the job, your
> agent builds it. Agents one-shot these workflows because it's React, which they
> already know.

*(advance → 1:05 — the live run begins; each line lands on its own picture)*

**[STEP 5 — live · describe · 1:05]**

> Here's what that looks like: I describe the job in chat, one sentence — and
> minutes later, a workflow exists.

*(advance → 1:13)*

**[STEP 6 — live · build · 1:13]**

> My agent authors the workflow — real source, tasks, a review loop; I never wrote
> a line. And it self-improves: every run is scored, and the prompts re-optimize
> weekly.

*(advance → 1:27)*

**[STEP 7 — live · run · 1:27]**

> It runs, every step streaming live — and I can time-travel back to any point in
> the workflow.

*(advance → 1:35)*

**[STEP 8 — live · gate · 1:35]**

> It pauses at my approval gate, costing nothing while it waits [CUT IF OVER: drop
> the cost clause]. Now watch — I kill the process mid-run… and it resumes exactly
> where it stopped. Every frame is saved.

*(advance → 1:49)*

**[STEP 9 — live · ship · 1:49]**

> Done. Reviewed, diffed, shipped.

*(advance → 1:53)*

**[STEP 10 — why we win · 1:53]**

> The right way to build agents shifts like a video-game meta: a new patch drops,
> everyone re-learns — but the engine stays. Smithers is the engine: it plugs into
> every agent, so every model release makes it stronger, not obsolete.

*(advance → 2:11)*

**[STEP 11 — market · 2:11]**

> Workflow automation was giant before agents — Zapier, UiPath, Temporal. After
> agents, it gets bigger: companies that never automated anything are asking to
> start. [CUT IF OVER: drop the company clause]

*(advance → 2:25)*

**[STEP 12 — business model · 2:25]**

> Smithers is free — that's distribution, and the canonical open-source engine is
> the moat. Revenue is the cloud that runs these workflows, plus the enterprise
> last mile.

*(advance → 2:38)*

**[STEP 13 — team · 2:38]**

> We know this space. In twenty twenty-five I built the fastest open-source
> Ethereum VM — with agents. Tevm, the OP Stack, now Smithers.

*(advance → 2:48)*

**[STEP 14 — the ask · 2:48]**

> We're looking for design partners — I'll work hands-on to integrate Smithers into
> your product or back office. Smithers makes agent workflows reliable. Come find
> me.

*(end · 3:00)*

---

## Delivery notes

- The traction hook is now the FIRST thing they hear (97K downloads in the opening
  line), and the full traction slide is step 2 — before any category language, so
  the first impression is users and outcomes, not "workflow orchestration".
- Slide 8 (the kill) is the money moment: pause half a beat after "watch," then say
  the kill line while the gate/scrubber image is up.
- The one-liner is the last thing they hear — hit "reliable".
- Numbers land better slightly slower: "ninety-seven *thousand*."
- Rehearse against the TTS: press **P** and shadow-read; if you consistently beat
  the voice to the next slide, you're at pace.
- If the timer shows red (< 20s) and you're not on step 13 yet, jump straight to
  the ask — it's self-contained.
