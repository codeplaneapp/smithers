# Smithers 0.33.1 launch thread

Production-hardening shape: exact-stats hook, failure-mode fixes on 2-3, operator reliability on 4, honest fix-count on 5, young-feature framing + CTA on 6. All numbers verbatim from stats; every non-CTA sentence maps to ledger claims; allowedInMarketing:false claims excluded. charCounts verified programmatically this pass as raw Unicode code points including newlines: 198/224/259/226/237/205, all under 280 (the tweet-6 URL counts as 23 via t.co; raw length shown).

---

### 1. Tweet 1
**Media:** [docs/images/0.33.1/monitor-live.gif — live Monitor recording of a release-canary run going green, used as the release hero → assets/tweet-01-hero.svg](assets/tweet-01-hero.svg)

> Smithers 0.33.1 is out. 20 commits, 55 files changed, 13 fixes.
>
> A hardening release: agent fallback chains, gateway UI discovery, and run resume all got more reliable.
>
> bunx smthrs@latest init
>
> 1/6

Claim IDs: claim-release-stats, claim-session-loss-fallback-fix, claim-gateway-health-lazy-discovery, claim-resume-detached-null-hash
Characters: 198

---

### 2. Tweet 2
**Media:** [capability card → assets/tweet-02-capability.svg](assets/tweet-02-capability.svg)

> Runs survive more failure modes now. retry-task detaches its engine invocation, so a closed pipe / SIGPIPE no longer kills the run and orphans its agent children. Detached runs with a null workflowHash can resume again.
>
> 2/6

Claim IDs: claim-retry-task-sigpipe-fix, claim-resume-detached-null-hash
Characters: 224

---

### 3. Tweet 3
**Media:** [capability card → assets/tweet-03-capability.svg](assets/tweet-03-capability.svg)

> Fallback chains fail over now. Session-loss errors (including Kimi's 'session is broken') are classified so the chain retries or falls through instead of silently skipping leads. Mixed-chain failures park as waiting-quota instead of hard-failing the run.
>
> 3/6

Claim IDs: claim-session-loss-fallback-fix, claim-mixed-chain-waiting-quota
Characters: 259

---

### 4. Tweet 4
**Media:** [docs/images/0.33.1/monitor-tour.gif — touring a finished run's UI, fits the gateway/UI reliability story → assets/tweet-04-capability.svg](assets/tweet-04-capability.svg)

> The gateway stays responsive under load. Workflow <UI> discovery now renders lazily in batches, so /health answers while dozens of UIs load. And smithers ui now finds workflows launched by explicit path outside .smithers.
>
> 4/6

Claim IDs: claim-gateway-health-lazy-discovery, claim-custom-path-ui-serve, claim-gateway-explicit-path-ui
Characters: 226

---

### 5. Tweet 5
**Media:** [capability card → assets/tweet-05-capability.svg](assets/tweet-05-capability.svg)

> The honest shape of this release: 13 of 20 commits are fixes. ctx.outputs(outputs.probe) resolves instead of silently returning [], up --resume no longer demands a workflow path, and panel moderators inside Ralph no longer deadlock.
>
> 5/6

Claim IDs: claim-release-stats, claim-ctx-outputs-callable-fix, claim-up-resume-no-workflow-path, claim-ralph-panel-deadlock-fix
Characters: 237

---

### 6. Tweet 6
**Media:** [capability card → assets/tweet-06-capability.svg](assets/tweet-06-capability.svg)

> New in the pack: upgrade-dependents forks every open-source dependent of the renamed npm package, upgrades it, reviews the diff, and opens a PR. Start with `bunx smthrs up ./my-workflow.tsx -d`.
>
> https://smithers.sh
>
> 6/6

Claim IDs: claim-upgrade-dependents-workflow
Characters: 220

---

## Media manifest

| Tweet | Asset | Kind |
|-------|-------|------|
| 1 | `assets/tweet-01-hero.svg` | hero |
| 2 | `assets/tweet-02-capability.svg` | capability |
| 3 | `assets/tweet-03-capability.svg` | capability |
| 4 | `assets/tweet-04-capability.svg` | capability |
| 5 | `assets/tweet-05-capability.svg` | capability |
| 6 | `assets/tweet-06-capability.svg` | capability |

**Rasterize to PNG for upload:** `node marketing/0.33.1/assets/render-pngs.mjs` (renders each card at 2x).
