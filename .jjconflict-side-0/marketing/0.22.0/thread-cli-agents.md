# Smithers 0.22.0 launch thread: CLI, agents, and workflow tooling

Ready-to-post X/Twitter thread for the non-Studio half of the 0.22.0 release. The
Smithers Studio 2 thread (`thread.md`) ships separately. Each tweet lists its media
attachment (files live in `./assets/`). Shape: hook, vision, primitive, depth,
depth, depth, then proof and CTA.

Product screenshots are real captures. Title and diagram cards are rendered from
the Studio 2 design tokens (`src/theme.css`). Copy follows the same anti-slop pass:
no em-dashes, no "it's not X, it's Y" framing, no padding triads, no hedging.

---

### 1. Hook
**Media:** `assets/cli-hero.png`

> Smithers 0.22.0 ships a big batch for the people writing agent workflows.
>
> A primitive that forks an agent's whole session. One command that wires Smithers
> into 20+ coding agents. A starter gallery, automatic prompt tuning, and live
> per-workflow UIs. 🧵

Names the concrete deliverables up front instead of promising "improvements." The
🧵 opens the loop into the detail tweets.

---

### 2. Vision (no lock-in)
**Media:** `assets/any-agent.png`

> You don't have to switch agents to use Smithers.
>
> One `smithers skills add` plus `smithers mcp add` wires it into Claude Code,
> Codex, Cursor, Copilot, Pi, Hermes, OpenClaw, and ~14 more. The agent you already
> run drives Smithers for you, with a drop-in skill and an MCP server.

Leads with the brand position (works with whatever you run) and backs it with the
exact two commands.

---

### 3. The primitive
**Media:** `assets/task-fork.gif` (static fallback: `assets/task-fork.png`)

> New primitive: `<Task fork="plan">`.
>
> It copies an agent's whole session into a fresh task, so you can chain plan →
> implement → verify, or fan out parallel branches from one base context. The
> source is never touched, and a fork can be forked again.

One concrete, quotable API. "Copies the whole session into a fresh task" is the
line people repeat.

---

### 4. Depth (onboarding)
**Media:** `assets/starters.png`

> New: `smithers starters`.
>
> Pick the outcome you want (idea-to-prd, ship-a-change, customer-incident,
> launch-checklist) and it hands you the exact command to run, what to gather
> first, and when not to use it. Ten starters map onto the seeded workflows.

Sells the fastest path to a first result. Real starter names make it concrete.

---

### 5. Depth (prompt tuning)
**Media:** `assets/optimize.png`

> New: `smithers optimize`.
>
> It runs your eval suite twice, once with current prompts and once with
> GEPA-generated patches, then writes the new prompt artifact only when the score
> clears `--min-improvement`. Your workflow structure, schemas, retries, and
> approvals stay untouched.

Gives a real number story (baseline vs optimized) and answers the "will this break
my workflow" worry in the same breath.

---

### 6. Depth (live workflow UIs)
**Media:** `assets/workflow-ui-review.png`

> `smithers init` now generates a bespoke React UI for every workflow, and
> `smithers ui` opens the right run in your browser.
>
> The Review workflow shows a live per-reviewer verdict bar. The Gateway console
> gained a Run Chronicle: a live tree, event log, and node inspector for any run.

Pairs the claim with a real generated UI screenshot. Show the output, don't
describe it.

---

### 7. Proof and CTA
**Media:** `assets/hardening.png`

> Under the hood, 0.22.0 also closed a round of security and correctness work:
>
> • XSS, local-RCE, path-traversal, DoS, and auth-bypass vectors
> • engine, time-travel, DB, graph, and observability fixes
> • a `HermesAgent` worker and OpenCode detection in `init`
> • memory-leak fixes across the gateway
>
> Full changelog: https://smithers.sh/changelogs/0.22.0

Leads the list with security and correctness to build trust, then one clean link.

---

## Media manifest

| Tweet | File | Source |
|------|------|--------|
| 1 Hook | `assets/cli-hero.png` | generated (theme tokens) |
| 2 Any agent | `assets/any-agent.png` | generated (theme tokens) |
| 3 Fork | `assets/task-fork.gif`, `assets/task-fork.png` | generated animation, static |
| 4 Starters | `assets/starters.png` | generated (theme tokens) |
| 5 Optimize | `assets/optimize.png` | generated (theme tokens) |
| 6 Workflow UIs | `assets/workflow-ui-review.png` | real Gateway capture |
| 7 Hardening | `assets/hardening.png` | generated (theme tokens) |

**Regenerate these cards:** edit `assets/_cards2.html`, then run
`node marketing/0.22.0/assets/_shoot2.mjs` (Chromium screenshots each `.card` at 2x).
The `task-fork.gif` is shared with the Studio thread (see `thread.md` for its
regen steps).
