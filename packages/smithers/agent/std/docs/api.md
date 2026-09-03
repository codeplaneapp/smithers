Every callable tool in this package is an ordinary `@smthrs/core` flow: a
declaration carrying `name`, `description`, `Input`, `Output`, `capabilities`
and `effects`, plus a handler where execution is host-owned. A host binds the
handlers it can serve and offers the declarations it wants a model to see.

```ts
import { Manifest, Read } from "@smthrs/std"
import { Effect } from "effect"

const program = Read.run({ path: "/workspace/notes.md" }).pipe(
  Effect.map((page) => page.content)
)

Manifest.flows // every declaration, by name
Manifest.handlers // the executable subset, by name
Manifest.effectsFor // the per-invocation envelope narrowing, by name
Manifest.readOnly // the names a read-only seat may see
```

`Manifest.effectsFor` is how a host narrows a declaration for one decoded call:
`bash` in `mode: "hermetic"` declares the caller's own `reads` and `writes`
rather than the registry-time worst case, and `read`, `edit`, `ls`, `glob` and
`grep` declare the path or subtree they were given. Every name in
`Manifest.names` has an entry.

## Limits

Every limit is a display budget disclosed to the caller, never a silent cut. A
capped result says so in its own output: `truncated`, `<stream>Truncated`, or a
`notice` line naming what was shown and what there was.

| Limit                             | Value       | Applies to                                                   |
| --------------------------------- | ----------- | ------------------------------------------------------------ |
| `DEFAULT_READ_LIMIT`              | 2,000 lines | one `read` page                                              |
| `MAX_LINE_CHARS`                  | 2,000       | one displayed line; a clipped line is not an edit anchor     |
| `MAX_ENTRIES`                     | 1,000       | one `ls` or `glob` page                                      |
| `MAX_GREP_MATCHES`                | 200         | one `grep` call                                              |
| `MAX_OUTPUT_BYTES`                | 60,000      | one rendered text payload (`fetch`, `http-post`, `webfetch`) |
| `MAX_SHELL_OUTPUT_BYTES`          | 30,000      | each captured shell stream                                   |
| `Bash.DEFAULT_TIMEOUT_MS`         | 600,000     | one `bash` call with no `timeoutMs`                          |
| `TestRun.DEFAULT_TIMEOUT_MS`      | 600,000     | one `test` call with no `timeoutMs`                          |
| `TestRun.MAX_CAPTURE_BYTES`       | 8,000,000   | the runner output one `test` call holds in memory            |
| `ShellCommand.DEFAULT_TIMEOUT_MS` | 10,000      | one `shell_command` call with no `timeout`                   |
| `ShellCommand.MAX_CAPTURE_BYTES`  | 8,000,000   | the command output one `shell_command` call holds in memory  |
| `NativeSearch.MAX_CAPTURE_BYTES`  | 64 MiB      | one `rg` invocation's captured output, refused past the cap  |
| HTTP response bytes               | 5 MiB       | `fetch`, `http-post` and `webfetch`, refused past the cap    |
| `webfetch` request timeout        | 120 s cap   | the request and the body read                                |
| Language-server frame             | 8 MiB       | one JSON-RPC frame, with an 8 KiB header bound               |
| `MAX_QUEUED_FRAMES`               | 256         | frames buffered for one language server's stdin              |
| `MAX_PENDING_REQUESTS`            | 512         | concurrent in-flight JSON-RPC requests to one server         |

Shell capture is bounded where it is read, not after: a command that prints
gigabytes costs the bound rather than the whole of what it printed, and the
`<stream>DroppedBytes` fields count what the process actually produced. Every
caller-supplied command — `bash`, `test`, `shell_command` — passes a bound. The
internal `git` plumbing calls behind `Checkpoints` and `TestRun`'s baseline do
not, because a listing read for its content is useless with its head missing.
Those
fields and the `<stream>Truncated` flags beside them are a wire convention
`@smthrs/harness/TruncatedOutput` reads to refuse a later write of those exact
bytes; renaming one disarms that guard silently.

## Failures

Handlers keep ordinary outcomes in the success channel: a non-zero exit code,
an empty match set and a 500 response are all values. `StdError` is reserved
for failures a model must see as failures, and its `code` is a closed, stable
list carried with the offending `path` where one exists.

| Code                       | Meaning                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `not_found`                | The named path or ref does not exist.                         |
| `not_a_file`               | A file operation was aimed at something that is not a file.   |
| `not_a_directory`          | A directory operation was aimed at something that is not one. |
| `is_directory`             | A read was aimed at a directory.                              |
| `binary_file`              | The bytes hold a NUL or are not valid UTF-8.                  |
| `offset_out_of_range`      | The requested page or line span is past the end.              |
| `invalid_pattern`          | The search pattern does not compile.                          |
| `invalid_input`            | The input is self-contradictory or names an unusable value.   |
| `no_match`                 | The edit anchor or patch context is not in the file.          |
| `not_modified`             | The write would leave the file exactly as it was.             |
| `outside_declared_reads`   | A hermetic path token is outside the declared read set.       |
| `outside_declared_writes`  | A hermetic path token is outside the declared write set.      |
| `command_failed`           | The process could not start, or a host operation failed.      |
| `request_failed`           | The HTTP or language-server request failed.                   |
| `timeout`                  | The call exceeded its wall-clock budget.                      |
| `provider_unavailable`     | No host bound the service this flow needs, or it refused.     |
| `unsupported`              | The service does not implement this query.                    |
| `unsupported_content_type` | The response is not a type this flow renders.                 |
| `response_too_large`       | The response exceeded the byte cap before decoding.           |

## Services a host binds

Six services are injected, and a flow whose service a host has not bound gets
the `makeNoop` refusal rather than a silent success. Refusing loudly is
the contract: a flow that appears to work while doing nothing costs a model the
frames it takes to notice.

| Service          | Needed by          | Bound by                                                        |
| ---------------- | ------------------ | --------------------------------------------------------------- |
| `Search`         | `grep`, `glob`     | `NativeSearch.layer` (ripgrep) or `PortableSearch` (in process) |
| `Container`      | `bash`, `test`     | `Container.layerCommand` (docker or podman)                     |
| `TestRunner`     | `test`             | the repository's own declaration                                |
| `Checkpoints`    | agent-side pinning | the git checkpoint store                                        |
| `WebSearch`      | `websearch`        | `ExaWebSearch.layer`                                            |
| `LanguageServer` | `lsp`              | `NodeLanguageServer.layer`                                      |

`NativeSearch` and `PortableSearch` are two implementations of one contract,
and `SearchContract` exports the matcher both build on so a third peer cannot
drift on what a pattern means. `SearchConformance` is how a peer proves it:
it generates a tree and a batch of calls from a seed, runs them through two
implementations, and reports every answer that differs. It found two drifts
between the peers shipped here, one in how `maxCount` interacts with context
lines and one in how `ignoreCase` and `smartCase` combine.

## Hermetic mode is a pre-check, not a sandbox

`bash` keeps `mode: "hermetic"` as effect-contract vocabulary. The handler
lexically pre-checks the explicit path tokens in the command against `reads`
and `writes`, resolving every token and every declaration before comparing, and
refuses the call when one falls outside. It then starts an ordinary host
process. Shell expansion, subprocesses, and paths computed at runtime are not
observed, so the check bounds what a caller declared it would do, not what the
process can do. A host that needs confinement supplies a sandbox or an
access-reporting boundary; this check alone cannot prove hermetic execution.

## Runtime

The root entry point is Node-only: it pulls `node:url` in through
`NodeLanguageServer`. The four search subpaths `@smthrs/std/Grep`,
`@smthrs/std/Glob`, `@smthrs/std/Search` and `@smthrs/std/PortableSearch` are
browser-safe and are the entries the browser contract checks. `internal/*` and
nested `*/index` subpaths are not exported and carry no promise.
