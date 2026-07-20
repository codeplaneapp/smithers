# Smithers 0.24.0 launch thread

Ready-to-post X/Twitter thread for the 0.24.0 release. Each tweet lists its media attachment. Shape: hook, then one capability per tweet with a concrete command, then proof and CTA. This mirrors how Anthropic and OpenAI post launches: a declarative one-line hook, plain-language capability tweets each carrying their own media, and a single link to close.

Title and diagram cards are rendered from the Smithers design tokens. Copy follows an anti-slop pass: no em-dashes, no "it's not X, it's Y" framing, no padding triads, no hedging.

Scope note for whoever posts this: the Aspects budget fields (costBudget, tokenBudget, latencySlo) shipped as declarative scaffolding only and are not yet enforced by the engine, so they are left out of the thread. The dts build fix and CI gate restoration are correctness items rolled into the proof tweet.

---

### 1. Hook
**Media:** hero card → [`assets/tweet-01-hero.png`](assets/tweet-01-hero.png)

> Smithers 0.24.0 is here.
>
> A headless Gateway command, workflow input schemas in inspect, parallel Loop that actually runs in parallel, and an event bridge so detached runs stream live.
>
> `bunx smithers-orchestrator gateway` 🧵

Leads with the most concrete new command and gives a reader something to run today. The 🧵 opens the thread.

---

### 2. Headless Gateway
**Media:** terminal screenshot of `bunx smithers-orchestrator gateway` startup output showing workspace and DB paths → placeholder [`assets/tweet-02-terminal.png`](assets/tweet-02-terminal.png) (capture a real terminal before posting)

> New: `bunx smithers-orchestrator gateway`.
>
> Starts the full `/v1/rpc/*` control plane headlessly, backed by the workspace database. Exposes `listRuns`, `streamRunEvents`, and `streamDevTools`. Prints the workspace and DB paths on startup.
>
> Distinct from `up --serve`, which runs one workflow. Use `gateway` when you need the control plane without launching a run.

Names the command, lists what it exposes, and draws the line between gateway and up --serve so readers know which to reach for.

---

### 3. Inspect knows your schema
**Media:** terminal screenshot of `bunx smithers-orchestrator inspect` output showing input schema fields alongside a run summary → placeholder [`assets/tweet-03-terminal.png`](assets/tweet-03-terminal.png) (capture a real terminal before posting)

> `bunx smithers-orchestrator inspect` now returns the JSON schema for each workflow's input.
>
> Real field names, types, defaults, enums, and descriptions. The same schema surfaces in generated skill docs instead of a generic placeholder.

Pairs the inspect surface with the generated-skill benefit. One fix, two places it shows up.

---

### 4. Parallel Loop runs in parallel
**Media:** diagram card showing before/after loop scheduling → [`assets/tweet-04-diagram.png`](assets/tweet-04-diagram.png)

> Parallel `<Loop>` iterations stalled until the entire run graph went quiet.
>
> Fixed. The engine now advances ready loops as each loop node completes. WorkflowDriver processes completions incrementally. No waiting for unrelated tasks to settle.

"Fixed." after a one-sentence bug description. No mechanics, no hedging.

---

### 5. Detached runs stream live
**Media:** terminal screenshot showing a detached run's events arriving in a connected Gateway client → placeholder [`assets/tweet-05-terminal.png`](assets/tweet-05-terminal.png) (capture a real terminal before posting)

> `bunx smithers-orchestrator up -d` runs now deliver real event frames to connected clients.
>
> A built-in out-of-process event bridge tails `_smithers_events` for runs the Gateway host didn't execute. On by default. Configurable via `outOfProcessEventBridge` and `outOfProcessEventBridgePollMs`.

"On by default" is the line that matters most: zero config change required for existing setups.

---

### 6. Init generates working agents
**Media:** terminal screenshot of `bunx smithers-orchestrator init` completing without errors → placeholder [`assets/tweet-06-terminal.png`](assets/tweet-06-terminal.png) (capture a real terminal before posting)

> `bunx smithers-orchestrator init` no longer generates a broken `agents.ts`.
>
> The default `smart` and `smartTool` pools now lead with a working Claude subscription provider. If no usable provider is found, init fails with `NO_USABLE_AGENTS` instead of writing a config that can't run.

Frames the fix as a DX guarantee: fail loud with a clear error, not cryptically mid-run.

---

### 7. Observability works out of the box
**Media:** terminal screenshot of `bunx smithers-orchestrator observability` starting the Docker Compose stack → placeholder [`assets/tweet-07-terminal.png`](assets/tweet-07-terminal.png) (capture a real terminal before posting)

> `bunx smithers-orchestrator observability` now ships with its Docker Compose stack files.
>
> The assets the command resolves at a known path were missing from the published package. They're included now. The prerequisite error names Docker Compose explicitly when it's absent.

Short. The fix is concrete and the improved error message is worth naming.

---

### 8. Proof and CTA
**Media:** changelog card → [`assets/tweet-08-changelog.png`](assets/tweet-08-changelog.png)

> 0.24.0: two new surfaces and seven targeted fixes.
>
> Also inside: CLI agent answers that survive stdout truncation, camelCase output table resolution in `bunx smithers-orchestrator output`, observability dts build passing, CI gates back to green on main.
>
> Full changelog: https://smithers.sh/changelogs/0.24.0
> GitHub: https://github.com/smithersai/smithers

Lists the remaining correctness fixes so nothing is buried. One link per destination.

---

## Media manifest

Cards are generated by the `release-content` workflow's `render-media` step (Smithers design tokens, zero dependencies). SVG is the committed source; PNG is rendered for upload.

| Tweet | Asset file | Kind | Notes |
|-------|------------|------|-------|
| 1 Hook | [`assets/tweet-01-hero.png`](assets/tweet-01-hero.png) | hero | generated |
| 2 Gateway | [`assets/tweet-02-terminal.png`](assets/tweet-02-terminal.png) | terminal | placeholder card — replace with a real capture of `bunx smithers-orchestrator gateway` |
| 3 Inspect schemas | [`assets/tweet-03-terminal.png`](assets/tweet-03-terminal.png) | terminal | placeholder card — replace with a real capture of `bunx smithers-orchestrator inspect` |
| 4 Parallel Loop | [`assets/tweet-04-diagram.png`](assets/tweet-04-diagram.png) | diagram | generated (before/after) |
| 5 Detached runs | [`assets/tweet-05-terminal.png`](assets/tweet-05-terminal.png) | terminal | placeholder card — replace with a real capture of `bunx smithers-orchestrator up -d` |
| 6 Init fix | [`assets/tweet-06-terminal.png`](assets/tweet-06-terminal.png) | terminal | placeholder card — replace with a real capture of `bunx smithers-orchestrator init` |
| 7 Observability | [`assets/tweet-07-terminal.png`](assets/tweet-07-terminal.png) | terminal | placeholder card — replace with a real capture of `bunx smithers-orchestrator observability` |
| 8 Proof/CTA | [`assets/tweet-08-changelog.png`](assets/tweet-08-changelog.png) | changelog | generated |

**Regenerate PNGs from the SVG sources:** `node marketing/0.24.0/assets/render-pngs.mjs` (renders each card at 2x via Playwright). The structured manifest is `assets/media-manifest.json`. The terminal cards are honest placeholders showing the real command; capture a live terminal for the polished post.
