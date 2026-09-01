# Execution

## Write-set confinement

A package-mode target that mutates the tree declares what it may write. Every
such run is wrapped: the tracked tree, the gitignored tree, and every escaping
symlink are measured before the body runs and again after, and any change whose
resolved location falls outside the declared write set is reverted and fails the
node.

Rollback is exact for tracked paths: a failed body has every tracked change it
made reverted, because a partial write from a tool that then errored is not a
state anyone asked for.

Gitignored paths are the stated exception. Their prior bytes are never stashed,
so reverting one deletes it rather than restoring it. Applying that inside the
node's own write set would destroy a pre-existing regenerable artifact the run
merely rewrote, so an out-of-set ignored write is reverted (it was never
authorized) and an in-set one is kept as it stands. A target that needs an
ignored output to be all-or-nothing declares it as an `outDir`, which is
captured and restored whole.

Git cannot see a write that lands through an in-workspace symlink whose real
target leaves the workspace, so those portals are measured directly, before and
after. A portal the census cannot measure — over the entry cap, or unreadable —
refuses the target. The guard has no partial mode: a confinement claim it cannot
keep is not made.

## Sandboxing

A target may declare `sandbox: { network: false }` or
`sandbox: { network: "loopback" }`. Enforcement is `sandbox-exec`, which exists
only on macOS. **On every other platform, Linux included, a declared sandbox is
not enforced**: the target runs with unrestricted egress, the run emits a
warning naming the target, and `--plan` reports `sandboxEnforced: false` beside
the declaration.

That matters because CI runs on Linux and macOS is the developer machine, so the
platform where isolation matters most is the one without it. Cache keys are safe
either way: the package-mode key material includes the platform and the
architecture, so a Linux-produced unsandboxed result can never be served to a
macOS run.

## Services

A target may depend on services the executor starts, refcounts across
consumers, and stops through a declared contract. Readiness is a port, an HTTP
URL, or an exec probe; health repeats the readiness probe on an interval. Every
probe and hook runs in the service's own working directory under the same
resolved environment the service process was given. Docker services publish
their declared ports on `127.0.0.1` only.

## Resource ceilings

Each boundary that reads something it did not produce holds an explicit limit,
and crossing one fails the target rather than exhausting the host:

- Captured output trees: depth, entry count, path bytes, per-file bytes, and
  total bytes (`PackageTree.outDirLimits`).
- Escaping-symlink portals: entry count (`PackageTree.portalEntryCap`).
- `S.Fetch` response bodies: byte count (`FetchExec.maximumFetchBytes`) and a
  request deadline (`FetchExec.fetchDeadlineMs`), independent of any caller
  signal. A rendered fetch URL is stripped of userinfo, query, and fragment; the
  full value stays in the failure's cause.
- Agent prompts and data files: byte count
  (`AgentSession.maximumSessionFileBytes` and `AgentTarget.maximumPromptBytes`),
  read through a descriptor proven to resolve inside the workspace so an
  in-workspace symlink cannot pull a host file into a model prompt.
- Rendered failure text: UTF-16 code units (`Diagnostic.maximumMessageCodeUnits`).
