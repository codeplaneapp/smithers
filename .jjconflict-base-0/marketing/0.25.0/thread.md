# Smithers 0.25.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.25.0 release. Every tweet has
an asset in `assets/` (PNG, plus an animated GIF for tweets 5 and 8).

---

### 1. Tweet 1

**Media:** [hero card → assets/tweet-01-hero.png](assets/tweet-01-hero.png)

> Smithers 0.25.0 is out.
>
> Hit a rate limit mid-run? The run now parks and resumes itself instead of failing. Plus new built-in agent tools and workflows that burn down your backlog and open PRs on their own.
>
> bunx smithers-orchestrator@0.25.0

Claim IDs: none

---

### 2. Tweet 2

**Media:** [capability card → assets/tweet-02-capability.png](assets/tweet-02-capability.png)

> The whole point of Smithers is a run that survives.
>
> Now when an agent hits a provider quota or rate limit (like the Claude 5-hour window), the run parks as waiting-quota and resumes itself when the limit resets. No failed run, no lost work.

Claim IDs: none

---

### 3. Tweet 3

**Media:** [assets/tweet-03-agent-tools.png](assets/tweet-03-agent-tools.png)

> Five new built-in agent tools, all harness-neutral:
>
> • grounded web search (Exa + Tavily/Brave/Serper)
> • generic HTTP for any REST endpoint
> • transcription (Whisper / Deepgram)
> • image generation
> • document + OCR parsing

Claim IDs: none

---

### 4. Tweet 4

**Media:** [assets/tweet-04-workflows.png](assets/tweet-04-workflows.png)

> New workflows in the init pack that do real work:
>
> • plan-implement-review-issues: one deduped PR per open GitHub issue
> • audit-burndown: clears your ticket backlog, gated on real typecheck + tests

Claim IDs: none

---

### 5. Tweet 5

**Media:** [assets/tweet-05-sidecar.gif](assets/tweet-05-sidecar.gif) (animated; static [assets/tweet-05-sidecar.png](assets/tweet-05-sidecar.png))

> New built in component: Sidecar
>
> Shadow-score a cheaper model to see if it is good enough
>
> For example: run Opus. But also in a non blocking way run same task with kimi. Over time you can use the built in evals/scoring in smithers to evaluate whether you can replace opus with kimi

Claim IDs: none

---

### 6. Tweet 6

**Media:** [assets/tweet-06-bulletproof.png](assets/tweet-06-bulletproof.png)

> Authoring upgrades:
>
> • ctx.output / outputMaybe / latest now infer row types from the table you pass, so your reads typecheck
> • the old tui folded into up --interactive: fuzzy picker, live status, inline approvals
>
> We upped the test coverage to 100% and added thousands of evals to uncover previously unreported bugs. Smithers is becoming bulletproof

Claim IDs: none

---

### 7. Tweet 7

**Media:** [assets/tweet-07-postgres-multiplayer.png](assets/tweet-07-postgres-multiplayer.png)

> Also in 0.25.0:
>
> Durability now runs on Postgres and PGlite alongside SQLite. A built in smithers migrate command will make this change seamless
>
> The above change enabled us to add @ElectricSQL and @tan_stack DB to Smithers UI for real time multiplayer updates. I am excited to show off the UI we are building on top of this!
>
> Also around 160 fixes. Thousands of new evals testing if haiku can one shot smithers workflows and answering questions using smithers cli. Improved docs based on those evals. And more

Claim IDs: none

---

### 8. Tweet 8

**Media:** [assets/tweet-08-downloads.gif](assets/tweet-08-downloads.gif) (animated; static [assets/tweet-08-downloads.png](assets/tweet-08-downloads.png))

> Smithers has over 10x the downloads per week since last release. We thank you and promise to keep shipping!

Claim IDs: none

---

## Media manifest

| Tweet | Asset | Kind |
|-------|-------|------|
| 1 | `assets/tweet-01-hero.png` | hero |
| 2 | `assets/tweet-02-capability.png` | capability |
| 3 | `assets/tweet-03-agent-tools.png` | list |
| 4 | `assets/tweet-04-workflows.png` | list |
| 5 | `assets/tweet-05-sidecar.gif` (+ .png) | animated reveal |
| 6 | `assets/tweet-06-bulletproof.png` | metric |
| 7 | `assets/tweet-07-postgres-multiplayer.png` | capability |
| 8 | `assets/tweet-08-downloads.gif` (+ .png) | animated count-up |

All PNGs are 3200×1800 (16:9, 2x). GIFs are 1280×720. X accepts PNG and GIF
uploads directly. To re-render the cards after editing an SVG:
`rsvg-convert -w 3200 -h 1800 assets/<card>.svg -o assets/<card>.png`.
