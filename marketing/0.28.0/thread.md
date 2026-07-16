# Smithers 0.28.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.28.0 release. Every tweet
has media in `assets/` (SVG sources render to PNG via `render-pngs.mjs`;
tweet 2 uses a real screen recording gif).

---

### 1. Tweet 1

**Media:** [hero card → assets/tweet-01-hero.png](assets/tweet-01-hero.png)

> Smithers 0.28.0 is here! Our biggest release ever: 1,169 commits, 4,187 files changed.
>
> A Monitor you operate fleets from, installable workflow packs, provenance-bound approvals, durable memory, and Node.js + browser support.
>
> bunx smithers-orchestrator@latest init

Claim IDs: release-scale, monitor, packs, provenance, memory-notes, runtimes
Characters: 265

---

### 2. Tweet 2

**Media:** [live Monitor recording → assets/monitor-live.gif](assets/monitor-live.gif)

> The Monitor became mission control.
>
> Health diagnosis with one-click resume, live transcripts, in-browser session hijack over a real PTY, frame scrubber, diffs, timeline, scores.
>
> The CLI opens it automatically when a run starts.

Claim IDs: monitor
Characters: 229

---

### 3. Tweet 3

**Media:** [pack lifecycle terminal card → assets/tweet-03-terminal.png](assets/tweet-03-terminal.png)

> You can now share workflows like packages.
>
> smithers add acme/review-pack (GitHub)
> smithers add npm:@acme/pack (npm)
> then packs update / eject / share / remove
>
> First release, rough edges expected. Installs are staged and atomic, so a bad pack can't wreck your repo.

Claim IDs: packs, pack-hardening
Characters: 266

---

### 4. Tweet 4

**Media:** [provenance diagram → assets/tweet-04-diagram.png](assets/tweet-04-diagram.png)

> The approval follows the artifact.
>
> ctx.prove() digests the exact row a human approved. \<Task bind\> re-checks it at schedule time. If the artifact changed, the task parks as BOUND_STALE instead of shipping stale work.

Claim IDs: provenance
Characters: 217

---

### 5. Tweet 5

**Media:** [runtime capability card → assets/tweet-06-capability.png](assets/tweet-06-capability.png)

> The same workflow core now runs in Node.js, Bun, the browser, Cloudflare Workers, and Vercel, behind a typed RuntimeAdapter with conformance suites on all five.
>
> AWS, GCP, Daytona, and Vercel join as first-class sandbox providers.

Claim IDs: runtimes, browser-runtime, sandbox-providers
Characters: 229

---

### 6. Tweet 6

**Media:** [delegation diagram → assets/tweet-05-diagram.png](assets/tweet-05-diagram.png)

> Agents that remember: append-only memory notes with provenance, human review, supersession history, and opt-in full-text search.
>
> Plus two delegation models: DelegationChain (fixed, inspectable) and Trellis (experimental, model-authored plans).

Claim IDs: memory-notes, delegation-chain, trellis
Characters: 244

---

### 7. Tweet 7

**Media:** [release inventory card → assets/tweet-07-changelog.png](assets/tweet-07-changelog.png)

> The honest shape of this release: 417 of 1,169 commits are fixes and 243 are tests, most aimed at the durable engine.
>
> Crash it, quota-park it, kill its owner process. 0.28.0 recovers more predictably than anything we've shipped.

Claim IDs: release-scale, hardening
Characters: 229

---

### 8. Tweet 8

**Media:** [upgrade terminal card → assets/tweet-08-terminal.png](assets/tweet-08-terminal.png)

> init got a redesign too: one question, then your agent takes over in a live tutorial session.
>
> Also new: status, what, why, pause, worktree prune, and an agent-assisted upgrade. Every green main commit ships to npm's next channel.
>
> Full tour: https://smithers.sh/changelogs/0.28.0

Claim IDs: init, cli, next-channel
Characters: 266 (after t.co link normalization)

---

## Media manifest

| Tweet | Asset | Kind |
|-------|-------|------|
| 1 | `assets/tweet-01-hero.png` | hero |
| 2 | `assets/monitor-live.gif` | screen recording |
| 3 | `assets/tweet-03-terminal.png` | terminal |
| 4 | `assets/tweet-04-diagram.png` | diagram |
| 5 | `assets/tweet-06-capability.png` | capability |
| 6 | `assets/tweet-05-diagram.png` | diagram |
| 7 | `assets/tweet-07-changelog.png` | changelog |
| 8 | `assets/tweet-08-terminal.png` | terminal |

SVG files are the editable source for cards. PNG files are rendered at
3200×1800 for upload; run `node marketing/0.28.0/assets/render-pngs.mjs` after
changing an SVG. `monitor-live.gif` is a real recording of the Monitor
following a live run (same file as `docs/images/0.28.0/monitor-live.gif`).

Tweets 3 and 8 use designed terminal cards rather than unpublished CLI output.
