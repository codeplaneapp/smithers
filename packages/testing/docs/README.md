# `@smthrs/testing` — local docs

Package-local notes for contributors. **First-class published guide:**

→ [Token-free visibility testing](../../../docs/guides/token-free-visibility-testing.mdx)

## Files here

| File | Role |
|---|---|
| [VIBE_CHECK_RUNBOOK.md](./VIBE_CHECK_RUNBOOK.md) | Herdr / ops dual-loop human vibe-check |
| [HUMAN_CHECKLIST.md](./HUMAN_CHECKLIST.md) | Short herdr checklist + sign-off |

## Quick commands

```bash
# A — engine scenarios (all planes share these truths)
pnpm -C packages/testing test

# Campaign plane=engine
bun packages/testing/scripts/core-campaign.mjs --plane engine

# Campaign plane=herdr (ops dock)
bun packages/testing/scripts/setup-ops-workspace.mjs --session smithers-dev
SMITHERS_HERDR_DOCK=1 bun packages/testing/scripts/core-campaign.mjs \
  --plane herdr --watch-pack --session smithers-dev --ops --pause-ms 6000
```

Fixtures: `../fixtures/agent-traces/README.md`
Scenarios: `../tests/scenarios/README.md`
