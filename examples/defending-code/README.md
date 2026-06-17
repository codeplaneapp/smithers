# defending-code

A Smithers port of Anthropic's
[`defending-code-reference-harness`](https://github.com/anthropics/defending-code-reference-harness):
autonomous vulnerability discovery and remediation, expressed as a durable
Smithers workflow.

The reference harness is a Python pipeline that finds and fixes memory-safety
bugs in C/C++ with Claude. Its signal is an **AddressSanitizer (ASAN) crash**, so
every finding is execution-verified: the program actually crashes on a crafted
input. This example keeps that shape and re-expresses the seven stages as a
Smithers JSX workflow, preserving the same contract. Agents craft inputs, run a
real ASAN-instrumented binary, and only report a bug when the program crashes.

> The original repo is unmaintained and meant as a reference. So is this port: it
> is a teaching demo on a deliberately-vulnerable toy target, not a product. For
> a managed offering, see Anthropic's Claude Security.

## The pipeline

The reference harness runs build, recon, find, verify, dedupe, report, patch.
Each stage maps onto Smithers primitives:

| Stage | Reference harness | This port |
|-------|-------------------|-----------|
| **build** | compile target into an ASAN image | compute `<Task>` running `clang -fsanitize=address` into a throwaway copy (no model) |
| **recon** | agent proposes input-parsing subsystems | one `ClaudeCodeAgent` reads the source, returns subsystems |
| **find** | N parallel agents craft inputs until a reproducible crash | `<Parallel>` fan-out, one agent per subsystem, crash confirmed 3/3 |
| **verify** | separate grader reproduces each crash in a fresh container | `<Parallel>` of independent verifier agents, fresh processes |
| **dedupe** | judge clusters crashes into unique bugs | one judge `<Task>` over the verified findings |
| **report** | report agent writes exploitability analysis | `<Parallel>` fan-out, one writeup per unique bug |
| **patch** | patch agent fixes, grader re-validates | one agent edits, rebuilds, and re-grades (PoCs neutralized + smoke test green) |

The durable, reactive fan-out comes from Smithers re-rendering the workflow each
frame: a stage renders once its inputs exist in `ctx.outputs`, and completed
tasks are never re-run. See `workflow.jsx`.

One faithfulness gap to call out: the reference patch grader also re-runs a fresh
find agent to confirm the fix cannot be bypassed (not just that the original PoC
stops crashing). This port grades rebuild + PoC-no-longer-crashes + smoke test,
and omits the re-find check to keep the demo a single short run. Adding a
post-patch re-fuzz stage is a natural extension.

## The target

`targets/card-parser` is a ~120-line C parser for a line-based "contact card"
format:

```
NAME: Ada Lovelace
EMAIL: ada@example.com
TAGS: math,compute,poetry
```

It ships with three planted memory-safety bugs, one per parsing subsystem
(`parse_name`, `parse_email`, `parse_tags`): two stack-buffer-overflows and one
heap-buffer-overflow. Well-formed cards parse cleanly and pass `smoke_test.sh`;
malformed cards overflow a fixed buffer and trip ASAN. The ground truth lives in
`targets/card-parser/EXPECTED-BUGS.md` and is never shown to the agents, since the
point is that the pipeline rediscovers it.

The pipeline builds and patches a **throwaway copy** under `runs/<run-id>/`, so
the committed source stays vulnerable and the demo is repeatable.

## Run it

Prerequisites:

- **Bun** (the Smithers CLI runs under bun) and a checkout of this monorepo.
- **clang with AddressSanitizer.** Preinstalled on macOS with the Xcode command
  line tools; on Linux, `clang` from your package manager.
- **Claude Code authentication.** By default the agents run via the `claude` CLI
  against your Claude subscription (see [Auth](#auth)). `claude` must be logged
  in (run `claude` once, then `/login`).

No install step is needed: the example runs in-place and resolves
`smithers-orchestrator` from the monorepo's workspace.

```sh
cd examples/defending-code

# Optional: prove the target builds and the planted bugs behave as expected.
sh harness/build.sh
sh targets/card-parser/smoke_test.sh                       # -> SMOKE_OK
printf 'NAME: %s\n' "$(printf 'A%.0s' $(seq 1 80))" > /tmp/poc.card
sh harness/run_target.sh targets/card-parser/build/card_parser /tmp/poc.card
                                                           # -> STATUS=CRASH KIND=stack-buffer-overflow ...

# Run the full pipeline (concurrency 3).
bun ../../apps/cli/src/index.js up workflow.jsx -c 3
```

`package.json` wraps these as scripts, so from this directory you can also run
`bun run build`, `bun run smoke`, `bun run graph`, `bun run up`, and
`bun run clean` (which wipes `runs/`, build artifacts, and `smithers.db` between
runs).

When it finishes, read the results:

```sh
RID=<run-id printed above>
bun ../../apps/cli/src/index.js output $RID summary --pretty   # roll-up
bun ../../apps/cli/src/index.js output $RID dedupe  --pretty   # unique bugs
bun ../../apps/cli/src/index.js output $RID patch   --pretty   # the fix + diff
bun ../../apps/cli/src/index.js inspect $RID                   # every stage
```

A successful run finds three crashes, verifies them, dedupes to three unique
bugs, writes a report per bug, and produces one patch whose diff neutralizes all
three PoCs while keeping the smoke test green. The `summary` task prints the
headline.

A real run (Claude Sonnet 4.5, concurrency 3, about 6 minutes):

```
[00:00:00] ok build
[00:02:10] ok recon            -> name, email, tags
[00:02:37] ok find-name / find-email / find-tags       (3 crashes)
[00:03:10] ok verify-name / verify-email / verify-tags (3/3 reproduced)
[00:03:30] ok dedupe           -> BUG-1, BUG-2, BUG-3
[00:05:16] ok report-bug-1 / report-bug-2 / report-bug-3
[00:06:17] ok patch            -> all 3 PoCs neutralized, smoke test passes

summary: {"subsystemsProbed":3,"crashesFound":3,"verified":3,
          "uniqueBugs":3,"bugsFixed":3,"patchValidated":true}
```

The patch the agent produced bounds every copy (`strcpy` to `strncpy` plus an
explicit NUL, and a `count < MAX_TAGS` guard), the same fix `EXPECTED-BUGS.md`
describes.

### Knobs

- `-c <n>`: global max concurrent tasks.
- `DEFENDING_CODE_MODEL`: model id passed to `claude` (default `claude-sonnet-4-6`).
- `DEFENDING_CODE_FANOUT`: per-stage `<Parallel>` concurrency (default 3).

## Auth

`ClaudeCodeAgent` runs the `claude` CLI. By default it **unsets
`ANTHROPIC_API_KEY`** so the run bills against your Claude subscription, matching
how you use Claude Code interactively. To bill the API instead, pass
`apiKey: process.env.ANTHROPIC_API_KEY` when constructing the agents in
`workflow.jsx` (the reference harness likewise accepts `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`).

## Safety

The reference harness runs each agent in a gVisor sandbox with egress restricted
to the Claude API, and **refuses to run unsandboxed** because the find and patch
stages execute attacker-shaped input against the target.

This demo makes a deliberate, scoped trade-off. The target is a tiny pure parser
that does no I/O beyond reading its input file, and the agents run with
`yolo: true` (skip-permissions) so they can compile and run it headlessly. Two
things to be honest about:

- `yolo: true` gives each agent **full host and network access** through Claude
  Code's own bash tool (not the network-isolated Smithers bash tool), and the
  agents are not wrapped in a `<Worktree>`/`<Sandbox>`. The "only write under
  `runs/<run-id>/`" instruction in the prompts is guidance, not enforcement.
- So what makes this safe is that it is a throwaway checkout with a trivial
  target and agent-authored inputs, not that the setup is sandboxed.

Run it only in a throwaway checkout. If you point this pipeline at real code,
restore the isolation:

- Wrap the executing stages in a Smithers `<Worktree>` or `<Sandbox>` so each
  agent works on an isolated copy.
- Smithers' own `bash` tool (`smithers-orchestrator/tools`) is network-isolated
  on macOS: it wraps commands in `sandbox-exec` with network denied, the local
  analog of the reference harness's egress restriction. On Linux it currently
  falls back to a static command denylist, which is weaker than kernel-level
  egress denial, so add an OS-level sandbox (gVisor, containers) there. Drive the
  find/patch stages with an `AnthropicAgent` (`@smithers-orchestrator/agents`)
  plus that tool to keep agent-run code off the network.
- Scope `ClaudeCodeAgent` tools with `allowedTools` / `disallowedTools` instead
  of `yolo`.

## Customize it for your stack

The reference harness notes that the pipeline's *shape* is generic. Porting it to
a new language or vuln class means answering three questions for your target.
This port keeps those three and adds a fourth knob:

1. **What signals a finding?** ASAN crash here. Could be an exception, a
   sanitizer of another flavor, a canary file, or a callback. Edit
   `harness/run_target.sh` and the `signal` block in `config.yaml`.
2. **What is a proof-of-concept?** A single input file here. Could be an HTTP
   sequence, a test harness, or a serialized message. Edit the find/verify
   prompts in `workflow.jsx`.
3. **How is the target built and run?** `clang -fsanitize=address` here. Edit
   `harness/build.sh` and `config.yaml`.
4. **What are the subsystems?** (this port's addition) The recon stage proposes
   them; seed it with hints in `config.yaml`.

## Files

```
workflow.jsx                     the seven-stage pipeline
harness/build.sh                 compile a source file with ASAN
harness/run_target.sh            run target on one input; always exit 0; emit STATUS
targets/card-parser/
  src/card_parser.c              the deliberately-vulnerable target
  config.yaml                    build/run/signal/focus config (per-target)
  inputs/valid-*.card            well-formed cards for the smoke test
  smoke_test.sh                  asserts valid cards still parse; takes an optional binary arg
  EXPECTED-BUGS.md               ground truth (for you, not the agents)
runs/<run-id>/                   per-run working copy + agent scratch (gitignored)
```
