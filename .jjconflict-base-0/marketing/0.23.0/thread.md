# Smithers 0.23.0 launch thread

Ready-to-post X/Twitter thread for the 0.23.0 release. Each tweet lists its media
attachment (files live in `./assets/`). Shape: hook, then one capability per tweet
with a concrete command, then proof and CTA. This mirrors how Anthropic and OpenAI
post launches: a declarative one-line hook, plain-language capability tweets each
carrying their own media, and a single link to close.

Title and diagram cards are rendered from the Smithers design tokens. Copy follows
an anti-slop pass: no em-dashes, no "it's not X, it's Y" framing, no padding triads,
no hedging.

Scope note for whoever posts this: the Postgres dialect is framed as a deployment
feature, not as another durability pitch. The unreleased chat PWA and the broader
crash-resume durability work are intentionally left out of this thread.

---

### 1. Hook
**Media:** `assets/hero.png`

> Smithers 0.23.0 is here.
>
> Describe a workflow in plain English and Smithers builds it: it designs the graph,
> scaffolds real files, and runs a verify loop until the workflow compiles, then
> writes the skill that documents it.
>
> `bunx smithers-orchestrator init` ships it seeded. 🧵

Leads with the most quotable capability (Smithers writes Smithers) and a command a
reader can run today. The 🧵 opens the loop.

---

### 2. Run it on Postgres
**Media:** `assets/postgres.png`

> Smithers now runs on PostgreSQL or an embedded PGlite.
>
> The storage layer is hand-written SQL, and a single dialect seam runs that exact
> SQL on SQLite, PGlite, or managed Postgres with no query rewrites. Develop against
> an in-process database, deploy against Postgres, same code.

Frames Postgres as where Smithers runs, not as a crash-resume story. "Same code"
answers the migration worry in three words.

---

### 3. Know your quota
**Media:** `assets/usage.png`

> New: `bunx smithers-orchestrator usage`.
>
> One report of how much rate limit or subscription quota each account has burned,
> across Claude Code, Codex, the Anthropic API, and the OpenAI API. Credentials are
> read host-side and never leave the process. Human table by default, `--format json`
> for scripts.

A utility everyone running agents wants. The credentials line heads off the obvious
security question in the same breath.

---

### 4. Any agent, any MCP server
**Media:** `assets/any-agent.png`

> A `<Task>` can be backed by Claude Code, Codex, Gemini, Antigravity, Hermes, and
> now Vibe (Mistral), all behind the same durable engine.
>
> And `createMcpToolset` connects any stdio MCP server, projecting its tools straight
> into an SDK agent. GitHub, Linear, whatever speaks MCP.

Reinforces the no-lock-in brand position and adds the inbound MCP half. Names real
agents and real tools instead of "integrations."

---

### 5. Workflows ship their own UI
**Media:** `assets/custom-ui.png`

> A workflow can ship its own browser UI through the Gateway, served at
> `/workflows/<key>` with live run, event, and node hooks.
>
> UltraGrill is the showcase: an open-ended real-time collaboration workflow you
> launch with one command, with a live custom UI driving the run over real RPC.

Pairs the platform capability (custom UIs) with a product built on it (UltraGrill),
so the abstraction lands with a concrete example.

---

### 6. Let an agent ask a human
**Media:** `assets/ask-human.png`

> New: an agent can stop and ask a person.
>
> When it is blocked, uncertain, or about to do something irreversible, it raises a
> durable request and blocks until a human answers. Ships as the `ask-human` CLI and
> the `ask_human` MCP tool, with fixed-choice decisions via `--choices`.

Human-in-the-loop framed as a safety valve. "Blocks until a human answers" is the
line that sells it.

---

### 7. jj, bundled
**Media:** `assets/bundled-jj.png`

> Smithers now ships a jj binary per platform, so worktree snapshots and forks work
> with no system install.
>
> A package manager pulls only the binary matching your host, and
> `bunx smithers-orchestrator workflow doctor` tells you up front when no usable git
> or jj is present.

A clean DX win. The doctor line shows Smithers fails loud instead of halfway.

---

### 8. Proof and CTA
**Media:** `assets/proof.png`

> 0.23.0 is the largest release since Smithers went public. Also inside:
>
> • four benchmark harnesses (SWE-Bench Pro, SWE-EVO, Claw-Eval-Live, RoadmapBench),
>   Opus 4.8 implementing and Codex reviewing
> • a defending-code example that finds vulnerabilities with AddressSanitizer
> • a correctness sweep: JSON extraction, DevTools stream recovery, strict Codex
>   schemas, the Pi plugin MCP bridge
>
> Full changelog: https://smithers.sh/changelogs/0.23.0

Leads the list with the benchmarks and the correctness work to build trust, then one
clean link.

---

## Media manifest

| Tweet | File | Source |
|------|------|--------|
| 1 Hook | `assets/hero.png` | generated (design tokens) |
| 2 Postgres | `assets/postgres.png` | generated (design tokens) |
| 3 Usage | `assets/usage.png` | generated (design tokens) |
| 4 Any agent | `assets/any-agent.png` | generated (design tokens) |
| 5 Custom UIs | `assets/custom-ui.png` | generated (design tokens) |
| 6 Ask human | `assets/ask-human.png` | generated (design tokens) |
| 7 Bundled jj | `assets/bundled-jj.png` | generated (design tokens) |
| 8 Proof/CTA | `assets/proof.png` | generated (design tokens) |

A real UltraGrill capture would be a stronger tweet 5 than the generated card. Swap
`assets/custom-ui.png` for a screenshot of `bun .smithers/scripts/ultragrill.ts`
running once one is captured.

**Regenerate cards:** edit `assets/_cards.html`, then run
`node marketing/0.23.0/assets/_shoot.mjs` (Chromium screenshots each card at 2x).
