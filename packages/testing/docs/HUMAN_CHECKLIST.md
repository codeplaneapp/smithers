# Human herdr checklist (gate C)

Full narrative: **`VIBE_CHECK_RUNBOOK.md`** (same directory). Use this as a short tick list once the campaign has left workspaces open.

## Before you start

1. Start / focus herdr UI (recommended session: `smithers-dev`).
2. Run the machine bridge **yourself** (agent does not open herdr for you):

```bash
pnpm -C packages/testing campaign:herdr -- --session smithers-dev --repeat 1 --pause-ms 2500
# or:
bun packages/testing/scripts/core-campaign.mjs --herdr --watch-pack --session smithers-dev --pause-ms 2500
```

3. Ignore pre-existing `poem-loop2` / `swarm-exception-desk` workspaces.
4. Open the new workspaces named `core-hello …`, `core-sequence …`, `core-parallel …`.

## Checklist (tick while looking)

### hello
- [ ] Workspace exists; label includes run id
- [ ] First tab is **cockpit** (or overview)
- [ ] Detail tab **hello** present
- [ ] Status not stuck as unknown forever after finish

### sequence
- [ ] Cockpit tab present
- [ ] Detail tabs for stages are readable (not sliver splits)
- [ ] After finish, can still read panes (linger / stub sleep)

### parallel (swarm soft-pin)
- [ ] **worker-03** (failed) is visible as its own tab
- [ ] Healthy **worker-01/02/04** are **not** flooding the tab bar
- [ ] Failed worker shows **blocked**-ish / attention in agent panel
- [ ] Cockpit still usable as overview home

### General
- [ ] Focus was not constantly stolen while campaign ran (if you were typing elsewhere)
- [ ] Workspace list remains navigable with multiple campaign runs
- [ ] Nothing requires a real LLM to understand the layout

## After

```bash
# optional cleanup of campaign workspaces
bun packages/testing/scripts/core-campaign.mjs --herdr --watch-pack --cleanup --only hello
# or close workspaces manually in herdr / smithers herdr clean
```

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Session | |
| Campaign ok (machine) | yes / no |
| Checklist | pass / fail |
| Notes | |
