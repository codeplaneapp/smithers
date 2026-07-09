# SOTA Model Registry

Keeping agents up to date is hard. Model IDs are pinned in dozens of places
(docs, the init pack, CLI codegen defaults), they go stale within weeks, and
nothing tells an end user that better models shipped. This spec adds one
canonical, versioned registry of state-of-the-art models, docs generated from
it, a daily GitHub cron that researches for new releases, and a client-side
once-a-day check that prompts users to upgrade when the registry moves.

## Canonical registry: `docs/data/sota-models.json`

One JSON file is the single source of truth. Everything else (the docs page,
the CLI default-model module, the llms bundles) is generated from it.

```jsonc
{
  "$schema": "./sota-models.schema.json",
  "version": 1,                  // monotonic integer; bump on ANY model change
  "updatedAt": "2026-07-06",     // date of last research pass
  "models": [
    {
      "id": "claude-fable-5",
      "provider": "anthropic",
      "name": "Claude Fable 5",
      "engines": ["claude", "opencode"],   // smithers agent engines that run it
      "status": "sota",                    // sota | current | deprecated
      "badges": ["best-orchestrator", "smartest-reviewer", "smartest-coder"],
      "roles": ["orchestrator", "planning", "review"],
      "description": "Anthropic's Mythos-class frontier model. ..."
    }
  ]
}
```

Field rules:

- `version` is a monotonic integer. Any change to `models` bumps it. The
  client-side release check compares integers, nothing else.
- `status: "deprecated"` keeps the entry (with its `replacedBy` id) so sweeps
  know what to purge; entries are only deleted a release after deprecation.
- `badges` come from a controlled vocabulary: `best-orchestrator`,
  `smartest-reviewer`, `smartest-coder`, `best-ui`, `fastest-coding`,
  `fast-and-cheap`, `best-open-source`, `best-value-coding`. At most one model
  holds a given badge at a time.
- `roles` map onto the fable-sandwich tiers in
  `apps/cli/src/agent-detection.js`: `orchestrator`, `planning`, `review`,
  `smart`, `implement`, `cheapFast`, `ui`, `realtime`.

### Initial contents (refreshed 2026-07-09)

| Model | ID | Badges | Notes |
| --- | --- | --- | --- |
| Claude Fable 5 | `claude-fable-5` | — | strongest non-Codex smart fallback |
| Claude Opus 4.8 | `claude-opus-4-8` | — | secondary smart Claude |
| Claude Sonnet 5 | `claude-sonnet-5` | — | cheap/fast implementer |
| GPT-5.6 Sol | `gpt-5.6-sol` | best-orchestrator, smartest-reviewer, smartest-coder | Codex-first planning, review, orchestration, and smart tier |
| GPT-5.6 Terra | `gpt-5.6-terra` | — | Codex-first validation, mid-tier, and tool-heavy tier |
| GPT-5.6 Luna | `gpt-5.6-luna` | fast-and-cheap, best-value-coding | Codex-first implementation, research, and cheap tier |
| GPT-5.5 | `gpt-5.5` | — | previous compatibility model; never a new-workflow default |
| GPT-5.4 / 5.4-mini | `gpt-5.4`, `gpt-5.4-mini` | — | previous flagship + fast variant |
| GPT-5.3-Codex-Spark | `gpt-5.3-codex-spark` | fastest-coding | 1000+ tok/s realtime coding (ChatGPT Pro) |
| Gemini 3.5 Flash | `gemini-3.5-flash` | best-ui | non-Codex UI fallback |
| Gemini 3.1 Pro | `gemini-3.1-pro-preview` | — | preview; superseded for coding by 3.5 Flash |
| Kimi K2.7-Code | `kimi-k2.7-code` | — | no-Codex implementation fallback |
| Kimi K2.6 | `kimi-k2.6` | best-open-source | open-source (modified MIT) trillion-param agentic MoE |

Deprecated (purge on sight): `claude-sonnet-4-6`, `claude-sonnet-4-7`,
`claude-sonnet-4-20250514` → `claude-sonnet-5`; `gpt-5.3-codex`, `gpt-5.2` →
`gpt-5.6-luna`; `gemini-3.1-pro-preview` stays `current` as the Gemini API default
fallback but the coding/UI role default moves to `gemini-3.5-flash`;
`kimi-latest` → pin `kimi-k2.7-code` (floating aliases hide model bumps from
the registry, so we do not use them).

## Generated surfaces

`scripts/generate-sota.ts` (run via `pnpm sota:gen`) renders, deterministic
and byte-stable:

1. **`docs/reference/sota-models.mdx`** — the human docs page: per-model
   descriptions, badge callouts, the role→model table, and the registry
   `version`/`updatedAt` stamped in frontmatter and visible text. Added to
   `CORE_PAGES` in `scripts/generate-llms.ts` so every llms bundle (and thus
   every agent reading the skill) ships it.
2. **`apps/cli/src/sota-models.generated.js`** — the CLI module exporting
   `SOTA_REGISTRY_VERSION`, `SOTA_MODELS`, and role→model-id maps.
   `apps/cli/src/agent-detection.js` (provider default templates,
   `AGENT_VARIANTS`, `ACCOUNT_PROVIDER_DEFAULT_MODEL`, `TIER_PREFERENCES`) and
   `apps/cli/src/runReport.js` import their IDs from it instead of inlining.

`scripts/check-sota.mjs` re-renders both and fails on drift; wired into the
root `pnpm test` gate next to `check-docs`/`check-llms`.

The `.smithers` pack (`.smithers/agents.ts` via init codegen,
`.smithers/components/roles.ts` defaults) and the seeded workflows are updated
to the registry's role defaults; `scripts/generate-workflow-pack.ts` re-embeds
them, so `smithers init` ships registry-fresh workflows.

## Daily research cron: `.github/workflows/sota-research.yml`

Runs daily (`30 6 * * *` UTC) + `workflow_dispatch`. Steps:

1. Checkout, install deps (pnpm), install Codex CLI, auth with the existing
   `CODEX_AUTH_JSON` secret (same dogfood pattern as `pr-review.yml`).
2. Run `bun scripts/sota-research.ts`: prompts Codex (web search enabled) to
   research whether any provider shipped new GA models since
   `updatedAt`, comparing against the current `docs/data/sota-models.json`.
   The agent must return strict JSON (proposed registry) which the script
   schema-validates; floating aliases and non-GA previews are rejected.
3. If the proposed registry differs materially: bump `version`, set
   `updatedAt`, run `pnpm sota:gen && pnpm docs:llms`, regenerate the workflow
   pack, and open a PR (`gh pr create`) titled
   `🤖 chore(sota): model registry update <date>` for human review. Never
   pushes to main directly — model swaps gate on a human merge.
4. If nothing changed: exit green without touching anything.

## Client-side release check (max once a day)

Extends the existing 24h-throttled update check
(`apps/cli/src/update-check.js`, marker `~/.smithers/update-check.json`) —
same budget, same marker file, one extra fetch:

- Alongside the npm latest-version fetch, fetch
  `https://raw.githubusercontent.com/smithersai/smithers/main/docs/data/sota-models.json`
  (1500ms timeout, failure-tolerant). Cache `{sotaVersion, sotaUpdatedAt}` in
  the marker.
- Compare against the baked-in `SOTA_REGISTRY_VERSION` from
  `sota-models.generated.js`. If remote > local, the post-command notice says:

  ```
  ↑ New SOTA models are out (registry v3, 2026-07-12). Run `smithers update`
    to upgrade, then `smithers init` to refresh your workflows to the latest
    agents.
  ```

- The prompt only fires when a *newer smithers release* also carries the new
  registry (remote registry version > baked-in one implies exactly that,
  since the baked-in copy updates with each release). Respect
  `SMITHERS_NO_UPDATE_CHECK=1`, TTY/CI guards, and the existing 24h stamp.
- `smithers update --check` prints the registry status too.

`smithers init` (re-init/refresh) already byte-compares pack files, so after
an upgrade the refreshed pack carries the new model IDs into user workflows;
that is the "update all workflows smithers knows about" half of the prompt.

## Non-goals

- No auto-merge of model swaps (human reviews the cron's PR).
- No per-request model routing changes; tiers keep their semantics, only the
  IDs behind them move.
- No new `smithers upgrade` command; `smithers update` (binary) +
  `smithers init` (pack refresh) remain the two verbs, and the notice names
  them both.
