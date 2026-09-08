---
title: "Limits"
description: "What @smthrs/sandbox bounds and what it buffers whole, per operation and per provider, and which providers keep a command's output byte exact."
---

Two things here are bounded and the rest is sized by the host's heap. A caller
placing an agent's file tools on a machine should know which is which.

| Path                                    | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a command's standard input              | 16 MiB, refused above it. The count runs as the bytes arrive, so an oversized or endless producer is stopped at the bound rather than after it finishes                                                                                                                                                                                                                                                                                                                   |
| the signal a closing scope sends        | 5 seconds, or however long it takes the command's exit to be observed, whichever comes first. A finalizer cannot be interrupted, so a provider whose `kill` never answers would hold the closing fiber open forever; the provider's own teardown sends it again. `string` and `lines` close the scope when the output ends rather than when the exit lands, so the exit observation is what keeps a command that already finished from costing its caller the whole bound |
| `Session.readFile`, `Session.writeFile` | none. A file crosses whole, in memory, on every provider                                                                                                                                                                                                                                                                                                                                                                                                                  |
| a command's `stdout` and `stderr`       | none. `RemoteChildProcessSpawner` and the probe helpers collect a command's output whole                                                                                                                                                                                                                                                                                                                                                                                  |
| `Sandbox.fileSystem.readDirectory`      | none, and a listing is materialized twice: once as probe output and once as the parsed entries                                                                                                                                                                                                                                                                                                                                                                            |
| `AwsSandbox` command output             | none, and buffered whole by construction: the Session Manager channel carries one session's output as a single stream that is parsed after it ends                                                                                                                                                                                                                                                                                                                        |
| `AwsSandbox` file writes                | require `ExecTransport.streamingSpawner`; one streaming session per `chunkBytes` bytes (default 3072, enforced range 1 through 65536 before base64). Payload travels on stdin. A 64 MiB write at the default needs roughly 22,000 sequential sessions                                                                                                                                                                                                                     |

Command output is byte-exact through `DirectorySandbox`, `ContainerSandbox`,
`KubernetesSandbox`, `MicrosandboxSandbox`, and `JustBashSandbox`. It is not
through `VercelSandbox`, `DaytonaSandbox`, or `CloudflareSandbox`, whose vendor
APIs report a command's output as a string: what those providers stream is that
string re-encoded as UTF-8, so a command writing a tarball or a compiled binary
to stdout comes back changed. `AwsSandbox` reframes output through a
pseudo-terminal, which normalizes line endings and interleaves standard error.
File transfer is byte-exact on all nine when the required transport is supplied, so a caller that needs bytes out of a
command has it write a file and reads that back with `readFile`.

## Read next

- [What a sandbox does and does not prevent](./concepts/isolation.md): the
  package adds no resource ceiling of its own beyond the two bounds above.
- [How a remote command differs from a local one](./concepts/remote-commands.md):
  why standard input crosses whole rather than as a pipe.
