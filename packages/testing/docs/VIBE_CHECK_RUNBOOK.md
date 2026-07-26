# Herdr vibe-check runbook (gate C — human half)

Cross-plane testing model: [Token-free visibility testing](../../../docs/guides/token-free-visibility-testing.mdx).

Machine gates **A** and **B**, plus the **machine half of C** (campaign loop + API asserts), are green. This runbook is only the **human visibility** pass for the **herdr plane**.

There is **no real LLM** — scripted agent-trace fixtures drive the engine with **2–5s randomized “think” delays**. Herdr panes run the **same real** `smithers supervisor` (overview board) and `smithers tail --node --hud --linger` (detail) as production (not empty `sleep` stubs).

**Not this step:** gate **D** (fuzz campaign) and gate **E** (LLM smoke). Do those only after you sign off here.

### What you should see (dual-control cockpit)

| Surface | Content |
|---|---|
| **cockpit left (~50%)** | Real harness CLI at prompt (`grok` / `claude` / …) — no model calls required |
| **cockpit right (~50%)** | **`smithers supervisor`** (portable board): fleet · header · attention · board · digest · recent · controls — fields update in place |
| **hello** / **implement** / **worker-03** tabs | **Node HUD**: scrollable stream in the middle + **fixed bottom dock** `[ s steer ] [ h hijack ] [ q close ]` |
| **Sidebar** | `core-*` labels, ✓/✗, agent status |
| **parallel** | Only **worker-03** detail tab (fail-promote); other workers board-only |

**Path A (dock):** run the campaign *from inside* a harness pane (`HERDR_ENV=1`) → we split **that** pane (harness stays left, overview right).

**Path B (spawn):** run the campaign from an outside terminal → new workspace with harness left + overview right.

If you still see bare `sleep 3600` with no split, you are on an old run or `--stub-panes`.

### Dual-control keys (`s` / `h`) — what works in fixture campaigns

| When | Key | Expected |
|---|---|---|
| Node tab, node still **working** | **`s`** then type message + Enter | Queues a durable **steer** (lands on next agent step). This is the dual-control to demo on fixtures. Press during the 2–5s “thinking…” window. |
| Node tab, run **finished** (linger) | **`s`** | Explains that steer only works mid-run — does **not** take over |
| Node tab, finished | **`h`** | Attempts **hijack** — needs a real `workflowPath` + agent session from `smithers up <file>` |
| Fixture campaign runs | **`h`** | **Expected to fail** with `HIJACK_WORKFLOW_PATH` — in-process fixtures never set a workflow file / hijackable CLI session |

**Takeover is not broken for production** — it is unsupported for token-free in-process campaigns by design. Use a real `smithers up workflow.tsx --herdr` for full S-takeover vibe-check.

---

## What you will see

The **watch-pack** (3 scenarios optimized for UI inspection):

| Workspace label pattern | Story | What “good” looks like |
|---|---|---|
| `core-hello …` / `…-hello-i0` | Single agent finishes | Tabs: `cockpit` + `hello` |
| `core-sequence …` / `…-sequence-i0` | implement → validate | Tabs: `cockpit` + stage tab(s) (e.g. `implement`); full-size, not slivers |
| `core-parallel …` / `…-parallel-i0` | 4 workers, one fails | Tabs: `cockpit` + **only** `worker-03` (failed); **not** 4 worker tabs |

Panes use live **`smithers supervisor --db …`** (fleet board) and **`smithers tail --node`** against a **shared** campaign `smithers.db` when liveUi (printed as `SMITHERS_CAMPAIGN_DB` / `[campaign] shared store …`). Expect overview boards and node streams similar to real runs; text is fixture scripted output, not a cloud LLM.

You can also open the board **outside** herdr in another terminal:

```bash
bun apps/cli/src/index.js top --db "$SMITHERS_CAMPAIGN_DB"   # path printed by the campaign
```

### Ignore pre-existing workspaces

If session `smithers-dev` already has workspaces like:

- `poem-loop2 run-…`
- `swarm-exception-desk run-…`

those are **your prior work**, not campaign fixtures. Leave them alone. Only inspect the new `core-hello` / `core-sequence` / `core-parallel` workspaces the campaign creates.

---

## Exact steps (preferred: operator-owned dual-control)

This matches the real human-in-the-loop flow: **you** own the herdr session/workspace and left harness; smithers only docks the **overview HUD** on the right.

### 0. Clean the session (pick one)

```bash
cd /home/jm/dev/harnussy/smithers

# Soft — campaign + smithers-ops only (keeps poem/swarm/etc.)
bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev

# Hard — every workspace except "~"
bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev --all

# Nuclear — stop the session (next herdr attach is empty)
bun packages/testing/scripts/cleanup-herdr-session.mjs --session smithers-dev --stop-session
```

### 1. Open herdr as you normally would

```bash
# Terminal A — herdr UI
herdr --session smithers-dev
```

(Or create a **new workspace** in an existing session you already use — same idea.)

### 2. Prepare the ops cockpit (left shell · right placeholder)

```bash
# Terminal B — from repo root
cd /home/jm/dev/harnussy/smithers
bun packages/testing/scripts/setup-ops-workspace.mjs --session smithers-dev
```

Focus workspace **`smithers-ops`**. You should see:
- **Left:** empty shell  
- **Right:** “waiting for a run” placeholder  

### 3. Start your harness on the left

In the **left** pane:

```bash
grok
```

(or `claude` / whatever you use — leave it at the prompt)

### 4. Run the campaign so the HUD docks on the right

Keep **`smithers-ops` focused** in herdr (so dock attaches there):

```bash
# Terminal B
SMITHERS_HERDR_DOCK=1 bun packages/testing/scripts/core-campaign.mjs \
  --herdr --watch-pack --session smithers-dev \
  --ops --pause-ms 6000
```

Expect: **right pane** becomes the overview **HUD** (fixed frame); **left** stays your grok; detail tabs appear for nodes as needed.

### Alternate: auto-spawn harness (no ops prep)

If you prefer the campaign to create workspaces and spawn `grok` itself:

```bash
bun packages/testing/scripts/core-campaign.mjs \
  --herdr --watch-pack --session smithers-dev --fresh --pause-ms 6000
```

**Expect CLI** (machine green):

```text
[campaign] ✓ hello …
[campaign] ✓ sequence …  tabs=cockpit,implement   # or similar stage tab
[campaign] ✓ parallel …  tabs=cockpit,worker-03
[campaign] done ok=true
[campaign] herdr workspaces left open for human inspection.
```

If `ok=false` or tabs differ wildly from the above, **stop** and paste the failure — no need to vibe-check a red run.

Optional slower loop while you watch the sidebar populate:

```bash
bun packages/testing/scripts/core-campaign.mjs \
  --herdr --watch-pack --session smithers-dev \
  --repeat 3 --pause-ms 3000 --iteration-pause-ms 2000
```

### 3. In herdr, inspect each new campaign workspace

Jump via workspace list / agent panel / your usual herdr nav.

#### hello
- [ ] New workspace appears; label includes run id / `hello`
- [ ] Tab **cockpit** exists
- [ ] Tab **hello** exists
- [ ] Layout is full-size tabs (not many thin splits)

#### sequence
- [ ] **cockpit** present
- [ ] Stage detail tab(s) readable (e.g. `implement` and/or `validate`)
- [ ] No unreadable sliver columns

#### parallel (most important — soft-pin / fail-promote)
- [ ] **worker-03** tab present (the intentional failure)
- [ ] **worker-01 / 02 / 04** do **not** all open as tabs
- [ ] Failure reads as attention / blocked in the agent list if shown
- [ ] Cockpit still a calm home tab

#### General
- [ ] Campaign did not constantly steal focus while you were elsewhere (if multi-tasking)
- [ ] Multiple workspaces remain navigable (campaign + any pre-existing)
- [ ] You can tell success vs failure from the UI without reading engine logs

### 4. Optional: second pass (loop feel)

If pass 1 looks good, one `--repeat 2` or `3` while watching the sidebar — confirm **no tab explosion** and no stuck “unknown” mass for campaign runs.

### 5. Cleanup (after you are done looking)

```bash
# closes only core-*/camp-* campaign workspaces (not poem/swarm)
bun packages/testing/scripts/core-campaign.mjs \
  --session smithers-dev --cleanup
```

Or close only the campaign workspaces manually in herdr. **Do not** clean `poem-loop2` / `swarm-exception-desk` unless you want those gone.

### Optional: one workspace at a time

```bash
bun packages/testing/scripts/core-campaign.mjs \
  --herdr --watch-pack --session smithers-dev \
  --fresh --reset-between --pause-ms 5000
```

---

## What this is / isn’t

| Is | Isn’t |
|---|---|
| Scripted fixture + real engine + real herdr mirror | Live LLM campaign (gate E) |
| Soft-pin / fail-promote / cockpit tabs | Property fuzz / long random loop (gate D) |
| Human taste + layout check | Automated pixel perfection |

---

## Sign-off (paste back to the agent)

```text
VIBE CHECK
date:
session: smithers-dev | default | other:
campaign CLI: ok=true / ok=false
hello: pass/fail — notes:
sequence: pass/fail — notes:
parallel: pass/fail — notes:
general: pass/fail — notes:
overall: PASS / FAIL
blockers for D/E:
```

After **overall: PASS**, we proceed to **D (fuzz campaign)** then **E (LLM smoke)** before any review/commits.
