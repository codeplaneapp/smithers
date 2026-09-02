# Execution

## Write-set confinement

A package-mode target that mutates the tree declares what it may write. Every
such run is wrapped: the tracked tree, the gitignored tree, and every escaping
symlink are measured before the body runs and again after, and any change whose
resolved location falls outside the declared write set is reverted and fails the
node.

Rollback is exact for tracked and gitignored paths alike. A failed body has
every change it made reverted, in set or not, because a partial write from a
tool that then errored is not a state anyone asked for. An out-of-set write to a
path that already existed gets its prior bytes, mode, or link target back, never
a deletion: the gitignored census holds every ignored file's bytes in a stash
before the body runs, and a tree it cannot hold whole (over
`PackageTree.ignoredLimits`, or holding a path it cannot read) refuses the
target before it runs.

The census costs what a body can change, not what the tree holds. It asks git
only for the paths that match an ignore pattern (`--ignored=matching`) and walks
each matched directory itself by `lstat`, never entering `node_modules` at any
depth, version-control internals, the cache directory, or a nested repository.
One stash (`PackageTree.IgnoredStash`) serves every guarded body in a run: a
census copies only the files whose `lstat` identity moved since the stash last
held them and drops the ones that vanished, so an unchanged ignored file costs
one `lstat` per body and a run's first census is the only one that copies the
whole ignored tree. Each snapshot reports its own accounting in
`IgnoredSnapshot.census` (entries, bytes, files copied, files reused). On this
repository the census fell from 23,149 entries and 880 MiB, 15,000 entries and
672 MiB of them under nested `node_modules` directories, to 8,150 entries and
208 MiB, well under the 50,000-entry and 1 GiB ceilings; a warm census takes
under a second where the old one took 20 to 30 s.

The one thing the census cannot restore is a directory git does not enter, a
nested repository. A write into one is reported as `not restored` and left
exactly as the tool left it, because removing it would destroy contents the
stash never held.

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
- The gitignored census: entry count, applied while the tree is walked, and
  bytes held in the stash (`PackageTree.ignoredLimits`).
- `S.Fetch` response bodies: byte count (`FetchExec.maximumFetchBytes`) and a
  request deadline (`FetchExec.fetchDeadlineMs`), independent of any caller
  signal. A rendered fetch URL is stripped of userinfo, query, and fragment; the
  full value stays in the failure's cause.
- Agent prompts and data files: byte count
  (`AgentSession.maximumSessionFileBytes` and `AgentTarget.maximumPromptBytes`),
  read through a descriptor proven to resolve inside the workspace so an
  in-workspace symlink cannot pull a host file into a model prompt.
- Rendered failure text: UTF-16 code units (`Diagnostic.maximumMessageCodeUnits`).
