# Smithers 0.28.0 launch thread

Ready-to-post X/Twitter thread for the Smithers 0.28.0 release. Every tweet has
an SVG source and a 2x PNG in `assets/`.

---

### 1. Tweet 1

**Media:** [hero card → assets/tweet-01-hero.png](assets/tweet-01-hero.png)

> Smithers 0.28.0 is out.
>
> The Monitor is now an operations console. Install and share workflow packs. Bind sensitive tasks to the exact evidence that authorized them. Run fixed or adaptive delegation.
>
> bunx smithers-orchestrator@0.28.0 init

Claim IDs: monitor, packs, provenance, delegation
Characters: 239

---

### 2. Tweet 2

**Media:** [operations console card → assets/tweet-02-capability.png](assets/tweet-02-capability.png)

> Operate a run without leaving the Monitor: live health diagnosis + Resume, per-node transcripts, in-browser session hijack, DevTools tree, frame scrubber, diffs, timeline, scores, crons, quotas, and agent/model attribution.

Claim IDs: monitor
Characters: 223

---

### 3. Tweet 3

**Media:** [pack lifecycle terminal card → assets/tweet-03-terminal.png](assets/tweet-03-terminal.png)

> Workflows are packages now.
>
> add installs a pack. packs update refreshes it. eject copies a workflow and its full UI/prompt/library closure for local editing. share opens the registry PR. remove uninstalls the pack.
>
> Installs and publishes use staged, symlink-safe copies.

Claim IDs: packs, pack-hardening
Characters: 272

---

### 4. Tweet 4

**Media:** [provenance diagram → assets/tweet-04-diagram.png](assets/tweet-04-diagram.png)

> Approvals now stay attached to what they approved.
>
> ctx.prove() digests the exact upstream row. <Task bind> checks it again at schedule time. If the artifact changed, the task parks as BOUND_STALE instead of acting with stale authority.

Claim IDs: provenance
Characters: 236

---

### 5. Tweet 5

**Media:** [delegation diagram → assets/tweet-05-diagram.png](assets/tweet-05-diagram.png)

> Delegation ships in two forms:
>
> • DelegationChain: a fixed plan/review/execute graph
> • Trellis: experimental runtime-authored delegation with strict IR validation, settled evidence, recursive fuel, and concurrency limits
>
> Trellis is opt-in, not in the default pack.

Claim IDs: delegation-chain, trellis
Characters: 265

---

### 6. Tweet 6

**Media:** [runtime capability card → assets/tweet-06-capability.png](assets/tweet-06-capability.png)

> Durable memory notes now carry provenance, supersession, review status, and lazy full-text search. A browser runtime runs the real WorkflowDriver behind typed capabilities. AWS, GCP, Daytona, and Vercel are first-class sandbox providers.

Claim IDs: memory-notes, browser-runtime, sandbox-providers
Characters: 237

---

### 7. Tweet 7

**Media:** [release inventory card → assets/tweet-07-changelog.png](assets/tweet-07-changelog.png)

> 0.28.0 spans 1,125 commits since the last published release, including 408 fix commits.
>
> Cancellation, quota parking, time travel, database migration, credentials, Gateway streams, generated types, plugins, tools, and pack writes all got a hardening pass.

Claim IDs: release-range, hardening
Characters: 255

---

### 8. Tweet 8

**Media:** [upgrade terminal card → assets/tweet-08-terminal.png](assets/tweet-08-terminal.png)

> Also new: status, what, pause, review, upgrade, and worktree list|prune; saved eval suites; cross-run score comparison; PoolAgent; deterministic scenario testing; and the npm next channel.
>
> Full changelog: https://smithers.sh/changelogs/0.28.0

Claim IDs: cli, evals, scores, pool-agent, testing, next-channel
Characters: 243

---

## Media manifest

| Tweet | Asset | Kind |
|-------|-------|------|
| 1 | `assets/tweet-01-hero.png` | hero |
| 2 | `assets/tweet-02-capability.png` | capability |
| 3 | `assets/tweet-03-terminal.png` | terminal |
| 4 | `assets/tweet-04-diagram.png` | diagram |
| 5 | `assets/tweet-05-diagram.png` | diagram |
| 6 | `assets/tweet-06-capability.png` | capability |
| 7 | `assets/tweet-07-changelog.png` | changelog |
| 8 | `assets/tweet-08-terminal.png` | terminal |

SVG files are the editable source. PNG files are rendered at 3200×1800 for
upload. Run `node marketing/0.28.0/assets/render-pngs.mjs` after changing an SVG.

Tweets 3 and 8 use designed terminal cards rather than unpublished CLI output.
