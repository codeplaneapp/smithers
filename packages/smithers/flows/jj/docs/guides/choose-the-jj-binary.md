---
title: "Choose which jj binary runs"
description: "Point the Node and Bun layers at a specific jj with SMITHERS_JJ_PATH, read the resolution back with resolveJjBinary, and print the operator guidance smthrs doctor shows."
sidebar:
  order: 4
---

`NodeJj` spawns the bare name `jj` and lets the operating system search `PATH`.
That is the right default and the wrong diagnosis: when it fails, an operator
needs to know which file was tried and why it was rejected.
`@smthrs/jj/node/resolveJjBinary` answers exactly that, and
[`smthrs doctor`](/cli/doctor) prints the answer.

## Override the binary

```bash
export SMITHERS_JJ_PATH=/opt/homebrew/bin/jj
```

`SMITHERS_JJ_PATH` is an operator saying "run this jj", so the override is the
file that actually runs, not a hint. Resolution order is short:

1. `SMITHERS_JJ_PATH`, when it names a file that exists.
2. `PATH`, searched for `jj` (`jj.exe` on Windows).

An override that names an existing file stays authoritative **even when it is
not executable**, so a broken explicit path is reported instead of a different
binary being quietly substituted. An override that names nothing that exists
falls through to `PATH`, and the fall-through is reported rather than silent:
an operator whose typo was disregarded otherwise gets a healthy report for a jj
they did not choose.

A resolution that came from `PATH` is spawned as the bare name `jj`, not as the
absolute path that was found. The operating system searches the same `PATH` a
moment later, and a host spawner that hands the child a different `PATH`, which
the contained bundles do, must keep deciding for itself.

## Read the resolution

```ts
import { describe, resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"

const resolved = resolveJjBinary()
console.log(describe(resolved))
```

`resolveJjBinary` always returns a command. When jj is genuinely absent it
answers the bare name `jj` with `executable: false` and a hint, which keeps the
soft-failure behavior every caller already has (`NodeJj` classifies the failed
spawn as `not_installed`) while giving `doctor` something specific to print.

`Resolved` carries what is known:

| Field        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `path`       | The command to spawn. Always spawnable, even when nothing usable exists. |
| `source`     | `"env"` for an override, `"path"` for the bare name left to the OS.      |
| `executable` | Whether the operating system can execute the candidate.                  |
| `hint`       | Present only when the resolution is known to be unusable.                |
| `variable`   | The override variable that supplied `path`, when `source` is `"env"`.    |
| `ignored`    | An override that named a path nothing exists at, and was skipped.        |

`describe` renders one line for an operator:

```text
jj: /opt/homebrew/bin/jj (SMITHERS_JJ_PATH)
jj: not found - No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH.
```

## Test a resolution without staging a filesystem

Every probe is injectable, so a test can pin the resolution order outright:

```ts
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"

const resolved = resolveJjBinary({
  environment: { PATH: "/usr/bin", SMITHERS_JJ_PATH: "/opt/jj" },
  platform: "linux",
  exists: (file) => file === "/opt/jj",
  executable: () => false
})
// { path: "/opt/jj", source: "env", executable: false, variable: "SMITHERS_JJ_PATH", hint: ... }
```

`overrideVariables` is the exported list of environment names the resolver
reads, so a diagnostic can enumerate them rather than hard-coding the string.

## The guidance an operator gets

`permissionHint(file, platform)` builds the remediation for a named jj that
cannot be executed. On macOS it adds the quarantine tip, because a downloaded
binary carries `com.apple.quarantine` and refuses to run with an error that
names neither the attribute nor the fix:

```text
Cannot execute the jj binary at /opt/jj. Run: chmod +x '/opt/jj'; xattr -d com.apple.quarantine '/opt/jj'; or point SMITHERS_JJ_PATH at a working jj.
```

The path is quoted with `shellQuote`, which is also exported. The hint is
advice an operator pastes into a shell, and the path in it is whatever they put
in `SMITHERS_JJ_PATH`: unquoted, a space makes the advice silently wrong and a
`;` or `$(...)` makes the paste run commands the hint never named.

`isExecutable(file, options)` is the probe behind all of this. It checks the
execute bit on POSIX and mere existence on Windows, where a vendored `.exe`
does not use POSIX mode bits. It is a probe and never a `chmod`: an unusable
candidate is reported, not repaired.

## What this package does not do

It vendors no `jj` binaries and downloads none. There is no bundled-package
branch to fall back to, so an absent jj is an operator's install, not a runtime
fetch.
