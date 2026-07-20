# Smithers 0.25.1 launch thread

Patch release thread. Migration fixes lead (tweets 2-3), Pi diagnostics in tweet 4, dogfood proof and upgrade CTA in tweet 5. No new product features claimed. All tweets under 280 chars. Tweet 3 charCount corrected to 254.

---

### 1. Tweet 1
**Media:** [Hero card showing Smithers 0.25.1 version → assets/tweet-01-hero.png](assets/tweet-01-hero.png)

> Smithers 0.25.1 is out.
>
> A patch for everyone running smithers migrate since 0.25.0. Migration errors are now actionable, legacy account entries no longer block commands, and --no-vcs / --no-deps / --no-mcp parse.
>
> 1/5

Claim IDs: claim-patch-no-new-product-features
Characters: 218

---

### 2. Tweet 2
**Media:** [Terminal screenshot showing DB_QUERY_FAILED output with actionable guidance text → assets/tweet-02-terminal.png](assets/tweet-02-terminal.png)

> The migrate command now wraps corrupt and unopenable SQLite stores in DB_QUERY_FAILED with actionable guidance instead of raw bun:sqlite errors.
>
> --to postgres validates the Postgres URL before opening the source.
>
> 2/5

Claim IDs: claim-migrate-corrupt-source-guidance, claim-migrate-unopenable-source-guidance, claim-migrate-postgres-url-validation-order
Characters: 218

---

### 3. Tweet 3
**Media:** [Terminal showing accounts.json warning skip and flag parsing success → assets/tweet-03-terminal.png](assets/tweet-03-terminal.png)

> Unknown/legacy provider entries in accounts.json are now skipped with a warning. Pre-0.25 files with a removed gemini entry no longer block bunx smithers-orchestrator init.
>
> The documented --no-vcs, --no-deps, and --no-mcp flags now parse correctly.
>
> 3/5

Claim IDs: claim-legacy-accounts-skip-unknown-provider, claim-negated-cli-flags-parse
Characters: 254

---

### 4. Tweet 4
**Media:** [Terminal showing Pi diagnostics provider-aware output with correct env var mapping → assets/tweet-04-terminal.png](assets/tweet-04-terminal.png)

> Pi diagnostics no longer default unknown providers to Google preflight checks. Known provider or model hints now map to the correct API key env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY).
>
> 4/5

Claim IDs: claim-pi-diagnostics-unknown-provider-skip, claim-pi-diagnostics-provider-env-mapping
Characters: 205

---

### 5. Tweet 5
**Media:** [Terminal showing successful migration completion output → assets/tweet-05-terminal.png](assets/tweet-05-terminal.png)

> Dogfooded on 12 real stores: run-ID parity, inspect parity, fresh compute runs, gateway reads, and time-travel all verified on migrated PGlite.
>
> bunx smithers-orchestrator@0.25.1
>
> https://smithers.sh/changelogs/0.25.1
>
> 5/5

Claim IDs: claim-dogfood-12-real-stores
Characters: 222

---

## Media manifest

| Tweet | Asset | Kind |
|-------|-------|------|
| 1 | `assets/tweet-01-hero.png` | hero |
| 2 | `assets/tweet-02-terminal.png` | terminal |
| 3 | `assets/tweet-03-terminal.png` | terminal |
| 4 | `assets/tweet-04-terminal.png` | terminal |
| 5 | `assets/tweet-05-terminal.png` | terminal |

SVG sources and the rasterizer are kept in `assets/` for edits.
