One thing here is bounded and the rest is sized by the host's heap. A caller
placing an agent's file tools on a machine should know which is which.

| Path                                    | Bound                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a command's standard input              | 16 MiB, refused above it. The count runs as the bytes arrive, so an oversized or endless producer is stopped at the bound rather than after it finishes                                                                                                                                                  |
| `Session.readFile`, `Session.writeFile` | none. A file crosses whole, in memory, on every provider                                                                                                                                                                                                                                                 |
| a command's `stdout` and `stderr`       | none. `RemoteChildProcessSpawner` and the probe helpers collect a command's output whole                                                                                                                                                                                                                 |
| `Sandbox.fileSystem.readDirectory`      | none, and a listing is materialized twice: once as probe output and once as the parsed entries                                                                                                                                                                                                           |
| `AwsSandbox` command output             | none, and buffered whole by construction: the Session Manager channel carries one session's output as a single stream that is parsed after it ends                                                                                                                                                       |
| `AwsSandbox` file writes                | one remote `aws ecs execute-command` round trip per `ExecTransport.chunkBytes` bytes (default 3072 before base64). A 64 MiB write at the default is roughly 22,000 sequential invocations. The option must be a whole number of at least 1; the upper end is the SSM document's own command-length limit |

Command output is byte-exact through `DirectorySandbox`, `ContainerSandbox`,
`KubernetesSandbox`, `MicrosandboxSandbox`, and `JustBashSandbox`. It is not
through `VercelSandbox`, `DaytonaSandbox`, or `CloudflareSandbox`, whose vendor
APIs report a command's output as a string: what those providers stream is that
string re-encoded as UTF-8, so a command writing a tarball or a compiled binary
to stdout comes back changed. `AwsSandbox` reframes output through a
pseudo-terminal, which normalizes line endings and interleaves standard error.
File transfer is byte-exact on all nine, so a caller that needs bytes out of a
command has it write a file and reads that back with `readFile`.
