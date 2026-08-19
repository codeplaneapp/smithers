# Plugin CLI resolution: three verified gaps

Status: review note for the in-flight four-tier rewrite of
`claude-plugin/lib/resolve-smithers-cli.mjs` / `codex-plugin/lib/resolve-smithers-cli.mjs`
(working-copy edits of 2026-08-19 ~01:15, owner session unknown; the three
smithers-* and flows-7d sessions all deny it). Written by the plue session
(769fc910) that independently root-caused the same plugin-monitor death.
Related landed work: commit dbd18fc1 makes the published bin's delegation and
`describeProtocolCommandSkew` honor the legacy `smithers-orchestrator`
package name.

## Background

The Claude Code plugin's background monitor runs `smithers claude monitor`
through the resolver. In any project where the resolver falls through to
`bunx smthrs`, bunx resolves by bin name, not package identity, so a
project-local bin can answer for the orchestrator and every protocol command
dies with a bare `Unknown command: claude` (exit 4). Observed 2026-08-19 in
two independent shapes: `@smthrs/build-cli` in flows (a `smthrs`-named bin)
and plue (below).

## Gap 1: tier 4 (`bunx smthrs`) is still hijackable via the declared bin name

In `/Users/williamcory/plue`, `bun x smthrs --version` prints `0.9.1`: bunx
finds `node_modules/.bin/smithers`, the pnpm shim for the project's
`smithers-orchestrator@^0.9.1` devDependency, and runs it. The bin name it
matches is the one the `smthrs` package declares (`smithers`), so this is a
distinct hijack from the flows `smthrs`-bin case. Proof: instrumenting the
bunx temp install (`$TMPDIR/bunx-501-smthrs@latest/.../smithers.js`) shows the
real 0.35.0 bin never executes; moving the `.bin/smithers` shim aside makes
the instrumented bin run and print 0.35.0.

Fix: use an explicit version spec in tier 4. `bun x smthrs@latest` disables
bun's local-bin shortcut (verified from plue). Same for
`resolveSmithersShellCommand`; add `@` to the shellQuote safe-character class
so the rendered command stays unquoted.

## Gap 2: tier 3 trusts any PATH executable named `smithers`

The Smithers Cloud forge CLI (plue `packages/npm-cli`) declares
`bin: { smithers, plue }`. A smithers.sh customer with that CLI installed has
a `smithers` on PATH that is not the orchestrator; tier 3 execs it and every
protocol command fails the same way. `findOrchestratorOnPath` cannot cheaply
verify identity for an arbitrary executable, so either accept and document the
risk, or probe the resolved bin once (`<bin> --version` / a marker subcommand)
before trusting it for protocol commands.

## Live regression evidence for gap 1 (added 2026-08-19 ~02:40)

The /workflows mirror (`claude-plugin/workflows/smithers-run.mjs`) now dies in
plue within ~24s, ticks returning
`{'status': 'error', 'outputs': {'error': 'Unknown command: claude'}}`
(journal wf_79e4e167-7a9 in session 769fc910). The mirror mirrored 15 ticks
fine at 00:42 before the rewrite. In the Workflow-subagent environment the
PATH tier misses (no global orchestrator on that PATH), the resolver falls to
tier 4 `bunx smthrs`, and plue's `.bin/smithers` shim (0.9.1) answers. An
explicit `smthrs@latest` in tier 4 fixes exactly this.

## Gap 3: tier 2 bypasses the protocol skew guard

`describeProtocolCommandSkew` lives in the published bin's delegation path.
Tier 2 runs an installed `node_modules/smthrs` bin directly, so an
old-but-installed pin (>= rename, < 0.27.0) regresses to the bare
`Unknown command: claude` the guard was built to catch. Either version-check
the installed manifest in the resolver before tier 2 returns, or route tier 2
through the published bin so the guard runs.
