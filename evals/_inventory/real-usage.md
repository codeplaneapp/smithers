# Real Smithers usage — mined from coding-agent session history

Mined from `~/.claude/projects/*` (Claude Code transcripts) and `~/.codex/` (history.jsonl
+ session rollouts) to ground an eval suite in genuine Smithers usage, prioritizing where the
agent **struggled**.

**Richest real consumers** (usage, not framework dev):
- `vibecode-room` — custom "smithering" orchestration layer on top of smithers-orchestrator (122k+ mentions, 1400+ struggle hits). The single best source.
- `tevm-monorepo` — multi-agent bug-hunt durable workflows over multiple repos (46k mentions).
- `fable-smithers` — authoring the `fable-build`/`smithering` meta-workflow and seeding it into the init pack.
- Codex sessions — `ticket-kanban`, `studio-parity-swarm`, `zevm-rebuild`, `open-code-review` durable runs + literal CLI history.

The `smithers/*` repo dirs themselves are **framework development**, not usage, so excluded.
Several consumer dirs (demo-smithers, takopi-smithers, paperclip-smithers, blanks, crush,
marketing, clawthereum) exist but have **no usable transcripts**. `matui`/`contexto` only
reference Smithers via the CC skill listing — no real use.

---

## Top 15 struggle themes (ranked by frequency × severity)

1. **Durability / resume after editing a workflow.** The #1 pain. Editing a `.tsx` invalidates
   resume ("Cannot resume run because durable metadata changed: workflow entry file changed" —
   seen 24× in one build). Agents don't know `fork --frame --reset-node` is the recovery path;
   one considered hand-editing `smithers.db`. Two inconsistent resume syntaxes
   (`--run-id X --resume true` vs `--resume <run-id>`) compound it. **Docs gap: a clear
   "I edited my workflow, how do I continue?" page.**

2. **`<Worktree>` isolation silently defeated.** Pinning `agent.cwd: process.cwd()` overrides
   the Worktree-injected cwd, so workers edit repo-root `src/` while every node goes green and
   0 code lands (~14 wasted build attempts). Plus `<Worktree path>` resolves relative to the
   workflow file's dir, not `process.cwd()` — a silent path mismatch. **Docs gap + footgun:
   Worktree cwd precedence and path-resolution base must be documented loudly.**

3. **`waiting-event` is an overloaded, misleading status.** It means *both* a genuine
   `<WaitForEvent>`/`<Signal>` pause *and* a retries-exhausted failure block — which need
   opposite recovery (`smithers signal` vs `smithers retry-task`/fork). Operators (and agents)
   guess wrong. **Docs/UX gap: distinguish "waiting on signal" from "blocked after failure".**

4. **Typed-input schema changes break persistence.** Changing a workflow's input shape yields a
   raw `SQLiteError: table input has no column named X` with no migration. Agents abandon typed
   schemas for untyped `ctx.input`. **Defect/doc gap: migrate the input table or emit an
   actionable error.**

5. **Task output contract (JSON-only) trips agents.** Tasks that return prose abort with
   "returned plain text, but Smithers task outputs must be JSON objects matching the declared
   output schema." Made worse by engine fallback wrappers that tell providers to "end with a
   json fence," conflicting with typed outputs; users spam defensive "output ONLY raw JSON, no
   markdown" preambles. **Docs gap: how to author a Task that reliably returns schema-valid JSON.**

6. **No built-in concurrency cap / rate-limit backoff for fan-out.** Single-burst fan-out of
   50+ finder agents reliably hits "Server is temporarily limiting requests · Rate limited" then
   "You've hit your session limit"; ~54/65 agents fail. Manual chunking didn't fix it. Worse, a
   run with 63/65 agents failed still reports `status: completed`, masking failure as success.
   **Feature gap: bounded concurrency + backoff + a degraded/failed run status.**

7. **`smithers init` pack defects.** Seeded `monitor.tsx` fails its own typecheck (TS2769 Zod
   `.default({})`); `smithers-snapshot-hook/SKILL.md` has invalid YAML frontmatter; durable
   state (`smithers.db*`, `.smithers/executions/`) ships with no default `.gitignore` and leaks
   into commits. **Real defects in the install pack.**

8. **CLI run-resolution by cwd + misdirecting error CTAs.** `smithers inspect`/`cancel` from a
   subdirectory returns `RUN_NOT_FOUND`; the error's CTA blames stale skills
   (`smithers skills add`) instead of the wrong id / wrong cwd, and a noisy Effect
   version-mismatch WARN pollutes stdout. **Defect: generic CTA mis-attached to unrelated errors;
   per-cwd DB resolution not surfaced.**

9. **Default agent cwd = `.smithers/workflows`, not the app root.** Agents launched by
   `smithers up` default to editing the dev pack instead of the parent app; a shell "inside a
   worktree" still ran tests against the repo root. **Footgun/doc gap on agent working dir.**

10. **No Smithers-native PreToolUse / per-tool interception.** Agents hunt the `.d.ts` for
    `preToolUse`/`beforeTool`/`toolInterceptor` (15+ wasted calls) — it doesn't exist. Correct
    answer: gate at the workflow level (Approval/Signal) or via Claude Code `settings.json` hooks.
    **Doc gap: a "how do I block a dangerous tool call?" answer.**

11. **Local-pack resolution (`.smithers/node_modules`) fragility.** `.smithers/package.json`
    without `node_modules` makes `smithers graph` fall through to a stale global cache and error
    on Zod load; the global launcher also mishandles the local shell-shim bin. **Setup/dispatch
    gap.**

12. **Detached resume lies.** `smithers up --resume` (detached) returns a PID but the run still
    shows cancelled — it exited immediately on the hash check without surfacing failure. Also,
    right after `--detach`, the SQLite DB is locked so inspect/logs error (no SQLITE_BUSY retry).
    **Defect: detached resume failure + early-startup lock not handled.**

13. **agents.ts misconfiguration surfaces too late.** A fallback chain led by an unsupported
    model (`gpt-5.3-codex` on a ChatGPT account) or an expired-OAuth provider (kimi
    `invalid_grant`) causes infinite non-fatal retries or an aborted first run, with no pre-flight
    check. `smithers agents test <label>` takes a **positional** label (agents guessed `--label`).
    **Doc gap + fail-fast feature.**

14. **`smithers graph` output noise + tsc OOM.** Graph (which runs no agents) still prints
    repeated `ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY` WARNs, forcing grep; typechecking a
    many-`.tsx` workflow pack OOMs. **Ergonomics gaps.**

15. **Discoverability: wrong verbs, undocumented conventions, model inheritance.** Agents invent
    `smithers run <name>` (no such verb; no "did you mean"); the custom-UI convention
    (`.smithers/ui/<key>.tsx`), the seeded-workflow pipeline, per-workflow gateway UI wiring, and
    `<Aspects>` enforcement status all had to be reverse-engineered from `node_modules`. A
    user-mandated model (Fable) was silently not applied because "agents inherit the session
    model" is false without an explicit per-agent override. **Broad doc-discoverability gap.**

---

## Most common real questions (these directly tell us which docs to write)

1. *"I edited my workflow — how do I resume the run without losing completed work?"* (fork/replay
   vs `--force` vs `--resume`; the two resume syntaxes).
2. *"My run is in `waiting-event` — is it waiting for a signal or is it stuck? What do I do?"*
3. *"Will `smithers init` overwrite my existing tickets/workflow edits?"* (non-destructive
   guarantees; `--format json` writtenFiles vs skippedFiles).
4. *"Why did my worktree-wrapped worker write to the repo root instead of its branch?"*
5. *"How do I read back a delivered signal payload, and how do WaitForEvent/Signal/submitSignal
   props line up?"*
6. *"Does a `<Task>` have to be agent/prompt-driven, or can it be a deterministic code task?"*
7. *"How do I make every agent in this workflow use model X?"*
8. *"How do I block a destructive tool call before it runs inside a Smithers agent?"*
9. *"How do I attach a custom UI to a workflow / serve a per-workflow gateway page?"*
10. *"How do I scope a glob-based ticket runner to a subset of tickets?"* (and not break the
    `input` table doing it).
11. *"My run says `completed` but most agents failed — is it actually done?"*
12. *"Does `<Aspects>` tokenBudget/costBudget/latencySlo actually get enforced at runtime?"*
13. *"How do I run and monitor a detached workflow to completion in the background (AFK)?"*

---

## Highest-value evals to build first

- **Edit-then-resume recovery** (fork/replay from last good snapshot; not a DB hack) — `sota`, fixture.
- **Worktree isolation** (don't pin `agent.cwd`; resolve paths from the engine; files land on the branch) — `sota`, fixture/deterministic.
- **`waiting-event` triage** (signal vs retry-task, apply the right recovery) — `sota`, fixture.
- **Typed-input schema change** (migrate or clear error, fresh run works) — `weak`, deterministic.
- **JSON-only Task output** (force schema-valid JSON; tolerate prose+fences) — `weak`, deterministic.
- **Bounded-concurrency fan-out** (cap + backoff; degraded-run detection) — `weak`, deterministic/judge.
- **`smithers init` pack health** (typechecks, valid skill YAML, `.gitignore` for durable state) — `weak`, deterministic.
- **Per-agent model override honored** (persisted run records model X for all agents) — `sota`, deterministic.
