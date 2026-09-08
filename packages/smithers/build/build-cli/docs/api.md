---
title: "API reference"
description: "Every export of @smthrs/build-cli: the CLI constructors, the process entry, the install adapter, and the fifteen namespaces the root barrel re-exports, with signatures."
---

```ts
import { cli, makeCli, Planner, Workspace } from "@smthrs/build-cli"
// or, by module path
import * as Reporter from "@smthrs/build-cli/Reporter"
```

The root barrel is a curated convenience, not the boundary. `package.json`
maps `./*` onto `src/*.ts`, so every module is importable by its own path
whether or not the barrel names it. A module earns a place in the barrel when
a host embedding the CLI drives it directly.

`@smthrs/build-cli/internal/*` and `@smthrs/build-cli/index` are not public.
`@smthrs/build-cli/package.json` is exported.

Several names repeat across modules and mean different things. `GateRunner`,
`LabelResolver`, `CheckEntry`, `ErrorCode`, and `make` each exist in more than
one module. Always qualify them by module.

Effect types appear throughout. A `Layer` provides a service and an `Effect`
is the deferred computation a runtime executes.

## The CLI

### Affected and Watch process lifetime

`@smthrs/build-cli/Affected` exports `changedPaths(root, options)`, `select`,
and `AffectedGitError`. Discovery options include `base`, optional `head` or
`files`, and optional `signal`, `environment`, and `timeoutMs`. The timeout is
per Git invocation, defaults to 60,000 milliseconds, and must be an integer
from 1 through 86,400,000. Each output stream is limited to 16 MiB and decoded
as strict UTF-8. Explicit files bypass Git. An already aborted signal refuses
the call before discovery.

`AffectedGitError` carries `_tag`, `code`, the exact Git `args`, and `cause`.
Codes distinguish `timed_out`, `cancelled`, `nonzero_exit`, `process_failed`,
`output_limit`, `cleanup_failed`, and `invalid_timeout`. Cleanup completes
before timeout or cancellation is reported, adding up to five seconds of TERM
grace and five seconds to verify disappearance after KILL. The CLI passes its
runtime signal and environment through to discovery.

`@smthrs/build-cli/Watch.run` resolves a cycle and invokes `cycleCompleted`
only after its owned POSIX process group is gone. File changes, watcher errors,
and the caller's signal all await that cleanup. Cleanup failure rejects the
watch instead of starting another cycle. See [Commands](./cli.md) for the
platform and parent-crash limits.

### makeCli

```ts
const makeCli: (config?: RuntimeConfig) => Cli
```

Creates the configured `smithers-build` CLI with all fourteen commands
registered. `serve(argv, { exit, stdout })` runs one invocation. Every field
of `config` replaces something the process would otherwise read for itself,
which is what makes an invocation testable. See
[Embed the CLI in another program](./guides/embed-the-cli.md).

### cli

```ts
const cli: Cli
```

`makeCli()` with no configuration: no process-scoped remote cache credentials,
no interruption signal, and no exit hook.

### RuntimeConfig

```ts
interface RuntimeConfig {
  readonly cacheUrl?: string | undefined
  readonly cacheToken?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdout?: Reporter.Terminal | undefined
  readonly stderr?: Reporter.Terminal | undefined
  readonly exit?: ((code: number) => void) | undefined
}
```

Process-scoped configuration captured before declaration evaluation.
`cacheUrl` and `cacheToken` are the already-captured remote-cache credentials.
`environment` defaults to `process.env` and is what agent-fake selection,
`PATH` lookups, and outward preconditions read. `exit` records the exit code
of a failure a human renderer has already explained, so the envelope's error
block is not printed twice; without it the structured error is returned
instead.

### normalizeArgv

```ts
const normalizeArgv: (argv: ReadonlyArray<string>) => ReadonlyArray<string>
```

Available from `@smthrs/build-cli/Cli`. Rewrites an argv whose first token
starts with `//` or `:` into `["target", ...argv]`. Every other argv passes
through unchanged.

## The process entry

From `@smthrs/build-cli/Entry`.

### Entry.Host

```ts
interface Host {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly stdout: Reporter.Terminal
  readonly stderr: Reporter.Terminal
  readonly on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly setExitCode: (code: number) => void
}
```

The slice of `process` the entry point touches. `on` must register a
persistent listener, never a one-shot one: the service supervisor's orphan
backstop reads `listenerCount(signal)` to decide whether to hard-kill, and
Node removes a one-shot listener before invoking it.

### Entry.main

```ts
const main: (host: Host) => Promise<void>
```

Runs one invocation against a host. `SMITHERS_CACHE_URL` and
`SMITHERS_CACHE_TOKEN` are read once and deleted from `host.env` before any
declaration evaluates. A signal aborts every running target and the process
exits 1 whatever the command was about to report.

## The install adapter

From `@smthrs/build-cli` and `@smthrs/build-cli/engine`. This is the runtime
adapter between the CLI and [`@smthrs/build`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build); every
assumption about that package's exports lives in one file.

### runInstall

```ts
const runInstall: (
  workspaceRoot: string,
  options?: {
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnvironment?: ReadonlyArray<string> | undefined
    readonly signal?: AbortSignal | undefined
    readonly toolchain?: Toolchain | undefined
  }
) => Promise<InstallResult>
```

Plans and executes the install flow under the declared toolchain, or under
`defaultToolchain` when the caller passes none. It refuses any
`cacheDirectory` other than `.flows`, because the package manager's store
boundary is fixed at `.flows/store`. Scoped per call, so concurrent callers
may run against different workspaces at once.

### InstallResult

```ts
interface InstallResult {
  readonly workspace: string
  readonly manager: PackageManager.Name
  readonly plan: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly dependencies: ReadonlyArray<string>
  }>
  readonly result: Install.LinkManifest
}
```

### Toolchain and defaultToolchain

```ts
interface Toolchain {
  readonly manager: PackageManager.Name
  readonly managerVersion: string
  readonly managerExecutable: string | undefined
  readonly runtime: Runtime.Name
  readonly runtimeVersion: string
  readonly runtimeExecutable: string | undefined
}

const defaultToolchain: Toolchain
```

`defaultToolchain` is pnpm on node with no version constraint, used when a
target declares none.

### The rest of the engine module

| Export                            | Signature                                                                                    | What it is                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `declaredToolchain`               | `(attrs: unknown) => Toolchain`                                                              | The toolchain a target declared, falling back to the default. |
| `packageManagerEnvironment`       | `(source, sensitiveEnvironment?, windows?) => Readonly<Record<string, string \| undefined>>` | The host environment without remote-cache credentials.        |
| `layerRuntime`                    | `(toolchain: Toolchain, environment?) => Layer`                                              | The runtime layer for this host.                              |
| `layerPackageManager`             | `(projectRoot, toolchain?, sensitiveEnvironment?, source?) => Layer`                         | The package-manager layer over the declared runtime.          |
| `layerInstall`                    | `Layer`                                                                                      | The install action implementations plus the registered flow.  |
| `layerNonInteractiveNodeServices` | `Layer`                                                                                      | The Node host services non-interactive execution needs.       |

`layerNonInteractiveNodeServices` deliberately omits `NodeTerminal`. The
aggregate layer attaches stdin listeners, and acquiring it in sixteen
concurrent flow runtimes produced leak warnings during ordinary CI even though
no target reads a terminal.

## Planner

Labels, key material, and the inert plan. From `@smthrs/build-cli` or
`@smthrs/build-cli/Planner`.

| Export                      | Signature                                                                                                | What it is                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Plan`                      | interface                                                                                                | A complete inert target plan: verb, pattern, roots, targets, edges, warnings.                  |
| `PlannedTarget`             | interface                                                                                                | One target in dependency-first plan order.                                                     |
| `PlannedEnvironment`        | interface                                                                                                | The resolved Nix environment recorded on a planned target.                                     |
| `Edge`                      | `{ readonly from: string; readonly to: string }`                                                         | One direct dependency edge.                                                                    |
| `KeyMaterial`               | `{ body: unknown; inputs: unknown; layers: ReadonlyArray<string>; capabilities: ReadonlyArray<string> }` | The four key fields the step-key law defines.                                                  |
| `encodeKeyMaterial`         | `(material: KeyMaterial) => string`                                                                      | Encodes key material into the injective byte string `keyOf` hashes.                            |
| `keyOf`                     | `(material: KeyMaterial) => string`                                                                      | The sha256 content key an executor caches on.                                                  |
| `targetKeyBody`             | `(target, metadata, outputs) => unknown`                                                                 | The persistent body identity of one target.                                                    |
| `attrsValue`                | `(value, depKeys, inputDigests, seen?, path?) => unknown`                                                | Canonicalizes attrs: target references become dependency keys, declared inputs become digests. |
| `fingerprintSources`        | `(roots: ReadonlyArray<SourceRoot>, options?) => Promise<string>`                                        | Digests the bytes of the implementation that will execute the plan.                            |
| `productionSourceRoots`     | `() => ReadonlyArray<SourceRoot>`                                                                        | The source trees whose bytes decide what an execution does.                                    |
| `implementationFingerprint` | `(signal?: AbortSignal) => Promise<string>`                                                              | The memoized fingerprint of the loaded implementation sources.                                 |
| `SourceRoot`                | `{ readonly name: string; readonly directory: string }`                                                  | One tree contributing to that fingerprint.                                                     |
| `EXECUTION_FORMAT`          | `number`                                                                                                 | Global cache-key salt for executor semantics.                                                  |
| `maximumSourceFileBytes`    | `number`                                                                                                 | Maximum bytes admitted from one implementation source file.                                    |
| `KeyMaterialError`          | class, carries `path`                                                                                    | A value in key material could not be encoded injectively.                                      |
| `UnsupportedVerbError`      | class, carries `pattern` and `verb`                                                                      | An exact target exists but does not participate in the requested verb.                         |

`PlannedTarget` is the row `--plan` prints:

```ts
interface PlannedTarget {
  readonly label: string
  readonly target: string
  readonly kinds: ReadonlyArray<Target.Kind>
  readonly attrs: unknown
  readonly dependencies: ReadonlyArray<string>
  readonly declaredInputs: ReadonlyArray<Workspace.ExpandedInput>
  readonly declaredOutputs: Target.DeclaredOutputs | undefined
  readonly cacheable: boolean
  readonly cacheLookup: "not-wired"
  readonly wouldRun: true
  readonly keyMaterial: KeyMaterial
  readonly keyPreview: string
  readonly nixEnvironment?: PlannedEnvironment | undefined
}
```

`attrs` are the verb-effective attrs, so a generator target's key material,
declared inputs, and cacheability differ between a `build` plan and a `lint`
plan.

## Label

The label grammar. From `@smthrs/build-cli/Label`.

| Export                      | Signature                                                                          | What it is                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Pattern`                   | `{ _tag: "Exact" \| "Subtree"; packagePath: string; target: string \| undefined }` | A parsed exact label or recursive pattern.                            |
| `parse`                     | `(value: string, currentPackage: string) => Pattern`                               | Parses `:name`, `//pkg`, `//pkg:name`, `//pkg/...`, `//pkg/...:name`. |
| `format`                    | `(packagePath: string, target: string) => string`                                  | Formats a path-derived label.                                         |
| `currentPackage`            | `(workspaceRoot: string, cwd: string) => string`                                   | The current package path; refuses a directory outside the workspace.  |
| `currentPackageOrUndefined` | `(workspaceRoot: string, cwd: string) => string \| undefined`                      | The same, answering `undefined` instead of throwing.                  |

## Query

Query result models and their text rendering. From `@smthrs/build-cli/Query`.

| Export          | What it is                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `Listing`       | A bare label or pattern query: `{ query, targets: [{ label, target, kinds, summary?, featured?, refusal? }] }`. |
| `Dependencies`  | A `deps(label)` query: `{ query, root, dependencies, edges }`.                                                  |
| `Dependents`    | An `rdeps(label)` query: `{ query, root, dependents }`.                                                         |
| `PackageOwners` | An `owners(label)` query: `{ query, package, owners, agentPolicy, upstream }`.                                  |
| `text`          | `(result, style?: Ansi.Palette) => string`. Renders any of the four for a person.                               |

## Audience

Import `@smthrs/build-cli/Audience` for the shared, side-effect-free consumer
policy used by target execution and durable control commands.

`resolve(options?)` accepts an injected environment, terminal facts, audience
override, formatting, MCP, and verbosity options. Its `Policy` records audience,
selection source, matched harness names, structured-result preference, progress
mode, and interactive capability; it never exposes environment values.

`fromArguments(argv, options?)` resolves executable presentation flags without
touching workspace state. `incurArguments(argv, policy)` selects Incur formatting
for harness-owned PTYs, using incremental JSONL for logs. `markers` is the
verified registry. Detection is never an authorization boundary; see
[output policy](./concepts/output.md) and [marker evidence](./reference/agent-detection.md).

## Reporter

The seam between execution and the terminal. From `@smthrs/build-cli/Reporter`.

| Export            | Signature                                                                                                   | What it is                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `uiModes`         | `readonly ["auto", "tty", "stream", "plain"]`                                                               | The `--ui` values.                                                         |
| `UiMode`          | `(typeof uiModes)[number]`                                                                                  | One `--ui` value.                                                          |
| `Renderer`        | `Exclude<UiMode, "auto">`                                                                                   | A concrete renderer: `auto` resolved.                                      |
| `Terminal`        | `{ write: (text: string) => void; isTTY: boolean; columns: number \| undefined }`                           | The stream a renderer writes to.                                           |
| `terminalOf`      | `(stream: NodeJS.WriteStream) => Terminal`                                                                  | Wraps a process stream as a `Terminal`.                                    |
| `Streams`         | `{ stdout: boolean; stderr: boolean }`                                                                      | Which streams are terminals.                                               |
| `resolveRenderer` | `(mode, env, streams, formatExplicit?) => Renderer`                                                         | Picks the renderer one invocation draws with.                              |
| `RunStart`        | `{ verb, pattern, jobs, targets }`                                                                          | Reported once before any target starts, so renderers size columns.         |
| `Reporter`        | interface with `begin`, `targetStarted`, `targetFinished`, `toolOutput`, `note`, `warn`, `summary`, `close` | The events execution reports.                                              |
| `MakeOptions`     | `{ renderer, terminal, env?, now?, interval? }`                                                             | What `make` needs beyond the renderer.                                     |
| `make`            | `(options: MakeOptions) => Reporter`                                                                        | Builds the reporter for one renderer.                                      |
| `of`              | `(options: { reporter?; log? }) => Reporter`                                                                | The given reporter, else plain over `log`, else plain over standard error. |
| `plain`           | `(writeLine: (line: string) => void) => Reporter`                                                           | The renderer that prints the historical lines and nothing else.            |
| `plainLine`       | `(report: TargetReport) => string`                                                                          | The status line for one settled target.                                    |
| `plainSummary`    | `(summary: Summary) => string`                                                                              | The end line for one run.                                                  |
| `formatDuration`  | `(durationMs: number) => string`                                                                            | Tenths of a second from one second up, whole milliseconds below.           |

Every renderer writes to standard error. Standard output stays the property of
the structured envelope, so `--format json` is never mixed with progress.

`TargetReport` and `Summary` are `@smthrs/build-cli/Executor` types.

## Workspace

Input expansion and remote-cache resolution. From `@smthrs/build-cli/Workspace`.

| Export                              | Signature                                                                           | What it is                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ExpandedInput`                     | `{ declaration: Input.Declared; files: ReadonlyArray<FileDigest>; digest: string }` | One declared matcher after discovery and measurement.               |
| `FileDigest`                        | `Input.FileDigest`                                                                  | A file and the digest that enters key material.                     |
| `declarationFileNames`              | `readonly ["PACKAGE.ts"]`                                                           | The only target declaration filename.                               |
| `ResolvedRemoteCache`               | `{ endpoint; credentials; discovered? }`                                            | The remote-cache settings one command runs under.                   |
| `ResolvedRemoteCacheCredentials`    | tagged union: `shared`, `split`, `public`, `anonymous`                              | Which credentials a workspace declared.                             |
| `RemoteCacheAccess`                 | `ResolvedRemoteCache` plus `readToken()`, `writeToken()`, `publishNamespace`        | A resolved cache with the readers that fetch its credentials.       |
| `credentialEnvNames`                | `(credentials) => ReadonlyArray<string>`                                            | Every environment name a resolved credential reads.                 |
| `remoteCacheOf`                     | `(declaration, endpointOverride?) => ResolvedRemoteCache \| undefined`              | Resolves a remote cache from an already-read declaration.           |
| `normalizeOverrideEndpoint`         | `(value: string) => string`                                                         | Validates the `SMITHERS_CACHE_URL` override.                        |
| `defaultSmithersCloudHosts`         | `ReadonlyArray<string>`                                                             | The hosts whose remotes identify a Smithers Cloud repository.       |
| `DiscoveredSmithersCloudRepository` | `{ repo: string; host: string }`                                                    | A repository found on a Smithers Cloud remote.                      |
| `parseSmithersCloudRemote`          | `(url: string, hosts?) => DiscoveredSmithersCloudRepository \| undefined`           | Parses one remote URL into `owner/name` on a Smithers Cloud host.   |
| `discoverSmithersCloudRepository`   | `(root, environment) => Promise<DiscoveredSmithersCloudRepository \| undefined>`    | Finds the Smithers Cloud repository a workspace's remote points at. |
| `smithersCloudCacheEndpoint`        | `(repo: string, environment) => string`                                             | The cache endpoint of a repository on Smithers Cloud.               |

The credential readers exist so a token value is fetched only while an
outbound request is being built, never held in a serializable field and never
part of a key.

## Resolver

TypeScript import-closure resolution, and the two actions built on it. From
`@smthrs/build-cli/Resolver`.

Parsing uses TypeScript 7's native compiler through its version-pinned
`unstable` API. The compiler receives only the supplied module and a synthetic
configuration in a closed virtual filesystem: no project configuration,
libraries, or imported files are loaded, and no source is executed or emitted.
Its process is closed after each parse. Syntax-error recovery is retained;
JSONC configuration loading and workspace resolution are separate operations.
Keep npm's platform-specific optional dependencies enabled so TypeScript's
matching native executable is installed.

| Export                      | Signature                                                                          | What it is                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ResolverConfig`            | `{ workspaceRoot; configDigest; baseUrl; paths; sources }`                         | The configuration one closure resolves under.                                          |
| `loadResolverConfig`        | `(options: { workspaceRoot; tsconfig? }) => Promise<ResolverConfig>`               | Loads it from the tsconfig chain.                                                      |
| `ResolverConfigError`       | class                                                                              | The tsconfig chain could not be read, or an entry lies outside the workspace.          |
| `extractSpecifiers`         | `(path: string, text: string) => ReadonlyArray<ExtractedImport>`                   | Syntax-only extraction of import, export, require, and dynamic-import sites.           |
| `ExtractedImport`           | `{ specifier: string; dynamic: boolean }`                                          | One extracted import site.                                                             |
| `resolveSpecifier`          | `(config, reader, fromFile, site) => Promise<RowEdge>`                             | Resolves one import into an explicit row edge.                                         |
| `RowEdge`                   | `{ specifier; status: EdgeStatus; resolved?; packageName? }`                       | One resolved specifier row.                                                            |
| `EdgeStatus`                | `"resolved-file" \| "package" \| "builtin" \| "unresolved" \| "dynamic"`           | The outcome of resolving one specifier.                                                |
| `FileRow`                   | `{ path; digest; edges }`                                                          | One file's digest plus every resolved specifier.                                       |
| `TreeView`                  | `{ root: string; kind(relativePath): Promise<EntryKind \| null> }`                 | The only filesystem surface resolution consumes.                                       |
| `EntryKind`                 | `"file" \| "dir" \| "other"`                                                       | What one workspace path is.                                                            |
| `computeClosure`            | `(options: { config; entries; cache?; maximumFiles? }) => Promise<ClosureOutcome>` | The transitive import closure of the entries.                                          |
| `ClosureOutcome`            | `{ result: Compose.ClosureResult; stats: ClosureStats }`                           | The deterministic result plus this run's counters.                                     |
| `ClosureStats`              | `{ parsed: number; cached: number }`                                               | Files extracted versus files answered from stored rows.                                |
| `ClosureError`              | class                                                                              | A closure computation failed.                                                          |
| `closureOfEntries`          | `(options: LiveOptions, entries) => Promise<Compose.ClosureResult>`                | Load, expand, and compute in one call.                                                 |
| `LiveOptions`               | `{ workspaceRoot; cacheDirectory?; tsconfig?; cache? }`                            | What the live bindings run under.                                                      |
| `expandAnchoredSources`     | `(options) => Promise<ReadonlyArray<string>>`                                      | Expands anchored sources to a sorted set of workspace-relative files.                  |
| `packageDirectoryOf`        | `(workspaceRoot: string, base: string) => string`                                  | Maps an anchored base onto its package path.                                           |
| `operandPaths`              | `(options, operand, side) => Promise<ReadonlyArray<string>>`                       | Reduces one file-algebra operand to its path set.                                      |
| `rowCacheTarget`            | `"ImportClosureRow"`                                                               | The cache target resolver rows are stored under.                                       |
| `rowCacheKey`               | `(fileDigest: string, configDigest: string) => string`                             | One resolver row's cache key.                                                          |
| `ImportClosureLive`         | `(options: LiveOptions) => Layer`                                                  | Implements the `smithers-build/import-closure` action.                                 |
| `CheckFilesDifferenceLive`  | `(options: LiveOptions) => Layer`                                                  | Implements `smithers-build/files-difference`.                                          |
| `implementationFingerprint` | `"smthrs-resolver/2"`                                                              | This resolver's identity, combined with the compiler version into every config digest. |
| `maximumClosureFiles`       | `number`                                                                           | Maximum files one closure may reach.                                                   |
| `maximumModuleBytes`        | `number`                                                                           | Maximum bytes of one module admitted to the parser.                                    |

## ServiceSupervisor

Services a target depends on. From `@smthrs/build-cli/ServiceSupervisor`.

| Export                      | Signature                                                                        | What it is                                                    |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ServiceSupervisor`         | `{ acquire: (spec: ServiceSpec) => Effect<ServiceHandle, ServiceError, Scope> }` | The per-command supervisor.                                   |
| `make`                      | `Effect<ServiceSupervisor, never, Scope>`                                        | Creates one whose services live at most as long as the scope. |
| `ServiceSpec`               | interface                                                                        | One resolved `Serve` target as the supervisor consumes it.    |
| `ServiceHandle`             | `{ key; pid; outputTail(); whileHealthy(consumer) }`                             | A live, ready service held by one consumer's scope.           |
| `ServiceError`              | tagged error with `key`, `reason`, `message`, `outputTail`                       | An acquisition or supervision failure.                        |
| `Readiness`                 | `{ port } \| { http, timeout } \| { exec, timeout }`                             | The readiness probe of a `Serve` target.                      |
| `Health`                    | `{ interval: string; failures?: number }`                                        | The health contract.                                          |
| `Stop`                      | `{ signal: string; grace: string }`                                              | The stop contract.                                            |
| `parseDurationMs`           | `(text: string, what: string) => number`                                         | Parses `"500ms"`, `"15s"`, `"2m"`, `"1h"`.                    |
| `defaultReadinessTimeoutMs` | `60_000`                                                                         | Overall readiness deadline for `{ port }` probes.             |
| `readinessPollMs`           | `250`                                                                            | Delay between readiness attempts.                             |
| `defaultHealthFailures`     | `3`                                                                              | Consecutive misses that mark a service unhealthy.             |
| `defaultStopSignal`         | `"SIGTERM"`                                                                      | Graceful-exit signal when the declaration omits `stop`.       |
| `defaultStopGraceMs`        | `5_000`                                                                          | Grace period before `SIGKILL`.                                |
| `outputTailLimit`           | `8 * 1024`                                                                       | Maximum captured output tail, in UTF-16 code units.           |

`ServiceError.reason` is one of `invalid-spec`, `spec-drift`, `spawn-failed`,
`exited`, `readiness-timeout`, `init-failed`, or `unhealthy`.

## AgentSession

The agent-target execution surface: sessions, candidate overlays, gates, and
verdicts. From `@smthrs/build-cli/AgentSession`.

### Sessions

| Export                  | Signature                                                                                            | What it is                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `AgentSession`          | `{ identity: string; run: (request: SessionRequest) => Effect<SessionEnvelope, AgentSessionError> }` | One open agent session.                                      |
| `SessionFactory`        | `{ open: (ref, mcp?) => Effect<AgentSession, AgentSessionError> }`                                   | Opens sessions for declared agent references.                |
| `SessionRequest`        | `{ purpose: "lint" \| "fix" \| "diff"; prompt: string }`                                             | What one session run is asked to produce.                    |
| `SessionEnvelope`       | `{ findings; edits; note }`                                                                          | One normalized session answer.                               |
| `EnvelopeSchema`        | Schema                                                                                               | The one JSON object every session must answer with.          |
| `parseEnvelope`         | `(text: string) => SessionEnvelope`                                                                  | Parses one answer into a normalized envelope.                |
| `makeCliSessionFactory` | `(options: CliSessionOptions) => SessionFactory`                                                     | A factory over the real `claude` and `codex` CLIs.           |
| `CliSessionOptions`     | `{ workspaceRoot; agents; executables?; timeoutMs?; sensitiveEnv? }`                                 | What that factory needs.                                     |
| `ConcreteAgent`         | `{ name: string; engine: "claude" \| "codex"; model: string }`                                       | One spawnable agent after pool expansion.                    |
| `resolveAgents`         | `(agents, ref) => ReadonlyArray<ConcreteAgent>`                                                      | Resolves a selector into the ordered agents a session tries. |
| `agentIdentityOf`       | `(resolved: ReadonlyArray<ConcreteAgent>) => string`                                                 | The key-material identity of one resolved agent list.        |
| `codexErrorMessages`    | `(stdout: string) => ReadonlyArray<string>`                                                          | The error messages a codex JSONL stream carries.             |
| `claudeMcpConfig`       | `(mcp: ReadonlyArray<Reference.McpHttp>) => string`                                                  | The `--mcp-config` document for the claude CLI.              |
| `precheckMcp`           | `(servers, timeoutMs?) => Effect<void, AgentMcpUnreachable>`                                         | Prechecks every declared MCP server before model spend.      |

### Candidates, gates, and verdicts

| Export                     | Signature                                                                 | What it is                                                                                 |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CandidateOverlay`         | `{ files; read(path); render() }`                                         | One immutable candidate tree: edits layered over the worktree.                             |
| `WriteSetApplier`          | `{ apply(edits, writeSet, base?); commit(overlay) }`                      | Applies edits confined to a write set and materializes them.                               |
| `makeLocalWriteSetApplier` | `(workspaceRoot: string) => WriteSetApplier`                              | Mechanical path validation, minimatch confinement, and refusal of any symlinked component. |
| `GateRunner`               | `{ run(gateIdentities, overlay, round) => Effect<...> }`                  | Runs declared gates against one round's exact candidate tree.                              |
| `unavailableGateRunner`    | `GateRunner`                                                              | Green for an empty gate set, a typed refusal for anything else.                            |
| `AgentVerdictStore`        | `{ get(key); put(key, value) }`                                           | Stores green verdicts under their full key.                                                |
| `VerdictKeyMaterial`       | `{ kind; diffDigest; promptDigest; agentIdentity; mode; gateIdentities }` | The full verdict key of one agent execution.                                               |
| `verdictKey`               | `(material: VerdictKeyMaterial) => string`                                | Encodes that material into one digest.                                                     |
| `makeMemoryVerdictStore`   | `() => AgentVerdictStore`                                                 | In-memory, one command's lifetime.                                                         |
| `makeFileVerdictStore`     | `(directory: string) => AgentVerdictStore`                                | File-backed under one directory.                                                           |
| `PrOpener`                 | `{ open(candidate) => Effect<string, AgentSessionError> }`                | Opens an accepted candidate as a pull request.                                             |
| `unavailablePrOpener`      | `PrOpener`                                                                | A typed refusal naming the integration point.                                              |

### Running a target

| Export                | Signature                                                                                                                           | What it is                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AgentRuntime`        | `{ workspaceRoot; sessions; writeSets; gates; verdicts; payloadValues?; dataFiles?; prOpener?; gitTimeoutMs?; mcpProbeTimeoutMs? }` | Everything one agent-target execution needs.                                      |
| `runAgentLint`        | `(runtime, payload) => Effect<LintReport, LintError>`                                                                               | Executes one `Agent.Lint` payload.                                                |
| `runAgentDiff`        | `(runtime, payload) => Effect<DiffResult, DiffError>`                                                                               | Payload decode, MCP precheck, bounded candidate and gate rounds, verdict caching. |
| `runAgentPr`          | `(runtime, payload) => Effect<PrResult, PrError>`                                                                                   | The same loop, then the PR settle through `PrOpener`.                             |
| `AgentLintLive`       | `(runtime: AgentRuntime) => Layer`                                                                                                  | Implements the `smithers-build/agent-lint` action.                                |
| `AgentDiffLive`       | `(runtime: AgentRuntime) => Layer`                                                                                                  | Implements `smithers-build/agent-diff`.                                           |
| `AgentPrLive`         | `(runtime: AgentRuntime) => Layer`                                                                                                  | Implements `smithers-build/agent-pr`.                                             |
| `decodePayloadValues` | `(spec, values) => Effect<Readonly<Record<string, string>>, AgentNeedsInput>`                                                       | Validates `--input` values against the declared spec.                             |
| `expandDiffSlice`     | `(workspaceRoot, diffs, timeoutMs?) => Effect<DiffSlice, AgentSessionError>`                                                        | Expands a target's `gitDiff` declarations into its data slice.                    |
| `DiffSlice`           | `{ files; patch; digest }`                                                                                                          | One expanded diff slice.                                                          |
| `renderDataFiles`     | `(workspaceRoot, files) => Effect<string, AgentSessionError>`                                                                       | Renders the `=== FILES ===` section of a prompt.                                  |

### Limits

`maximumSessionOutputBytes` (4 MiB), `maximumDiffSliceBytes` (16 MiB),
`maximumSessionPromptBytes` (8 MiB), `maximumSessionFileBytes` (512 KiB),
`defaultSessionTimeoutMs` (5 minutes), `defaultMcpProbeTimeoutMs` (2.5
seconds), and `defaultGitTimeoutMs` (30 seconds).

## AgentFake

The deterministic replacement for a real agent CLI. From
`@smthrs/build-cli/AgentFake`.

| Export                          | Signature                                                        | What it is                                                                                    |
| ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `fakeEnvironmentVariable`       | `"SMTHRS_AGENT_FAKE"`                                            | Names the script file that selects the fake.                                                  |
| `timeoutEnvironmentVariable`    | `"SMTHRS_AGENT_TIMEOUT_MS"`                                      | Names the per-session wall-clock ceiling.                                                     |
| `sessionTimeoutFromEnvironment` | `(env) => number \| undefined`                                   | Reads that ceiling: a positive integer of milliseconds, or unset.                             |
| `FakeScript`                    | Schema and type: `{ identity?; responses }`                      | One fake script file.                                                                         |
| `ScriptedResponse`              | Schema and type: `{ purpose?; findings?; edits?; note?; fail? }` | One scripted session response.                                                                |
| `loadFakeScript`                | `(path: string) => FakeScript`                                   | Reads and decodes one script; an invalid one throws rather than degrading into an empty fake. |
| `makeScriptedSessionFactory`    | `(script, options?) => ScriptedSessionFactory`                   | Replays one script deterministically.                                                         |
| `ScriptedSessionFactory`        | `SessionFactory` plus `opens()`, `spawns()`, `requests()`        | Exact spawn accounting for assertions.                                                        |
| `ScriptedFactoryOptions`        | `{ logPath?: string }`                                           | Where the factory logs, if anywhere.                                                          |
| `sessionFactoryFromEnvironment` | `(options, env) => SessionFactory`                               | The scripted fake when the variable names a script, the real factory otherwise.               |
| `makeScriptedGateRunner`        | `(reports) => ScriptedGateRunner`                                | Replays one scripted report per call, in order.                                               |
| `ScriptedGateRunner`            | `GateRunner` plus `calls()`                                      | Call accounting for assertions.                                                               |
| `ScriptedGateCall`              | `{ round: number; gates; files }`                                | One recorded scripted gate-runner call.                                                       |
| `promptFilesOf`                 | `(prompt: string) => ReadonlyArray<string>`                      | The paths under a prompt's `=== FILES ===` section, for cross-process proofs.                 |

## CreateApp

The `create-app` implementation. From `@smthrs/build-cli/CreateApp`.

| Export            | Signature                                               | What it is                                                              |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `scaffold`        | `(options: ScaffoldOptions) => Promise<ScaffoldReport>` | Copies one template into a new directory.                               |
| `ScaffoldOptions` | `{ directory; template?; templateRoot? }`               | `template` defaults to `default`.                                       |
| `ScaffoldReport`  | `{ directory; name; template; files }`                  | What one scaffold copied.                                               |
| `templateRoot`    | `() => string`                                          | Locates the `template` directory of the installed `@smthrs/create-app`. |
| `templates`       | `(root: string) => Promise<ReadonlyArray<string>>`      | The template names a directory offers, sorted.                          |

## GitCommit

The `Git.Commit` implementation. From `@smthrs/build-cli/GitCommit`.

| Export             | Signature                                                                                  | What it is                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commit`           | `(options: CommitOptions) => Promise<CommitResult>`                                        | Stage, gate, message, commit.                                                                                                                                                  |
| `CommitOptions`    | `{ root; paths?; sweepWorkingTree?; target; gateRunner; agentMessage?; messageOverride? }` | One invocation's inputs.                                                                                                                                                       |
| `CommitResult`     | `{ sha; message; staged }`                                                                 | The created commit.                                                                                                                                                            |
| `GitCommitError`   | class carrying `code` and `failures`                                                       | One typed refusal.                                                                                                                                                             |
| `isGitCommitError` | `(value: unknown) => value is GitCommitError`                                              | Guard.                                                                                                                                                                         |
| `ErrorCode`        | union                                                                                      | `not_a_git_repository`, `invalid_paths`, `unrelated_changes`, `nothing_to_commit`, `gates_failed`, `agent_message_unavailable`, `empty_message`, `git_failed`, `spawn_failed`. |
| `GateFailure`      | `{ target: string; message: string }`                                                      | One red gate.                                                                                                                                                                  |
| `GateRunner`       | `{ run(gates: ReadonlyArray<Target.AnyTarget>): Promise<ReadonlyArray<GateFailure>> }`     | Runs gates against the staged tree.                                                                                                                                            |
| `AgentMessage`     | `{ compose(context) => Promise<string> }`                                                  | Composes a message for an agent-written `message` declaration.                                                                                                                 |

`--sweep` sets `sweepWorkingTree`. Without it, a commit with no declared path
scope refuses with `unrelated_changes` and names the paths it does not own.

## GitHooks

The `gitHooks` implementation. From `@smthrs/build-cli/GitHooks`.

| Export              | Signature                                                                             | What it is                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `resolveHookLabels` | `(workspace, resolve: LabelResolver) => Readonly<Partial<Record<HookName, string>>>`  | Resolves the workspace bindings to labels.                                        |
| `render`            | `(bindings) => ReadonlyArray<{ file: string; content: string }>`                      | The deterministic hook script set.                                                |
| `check`             | `(root, rendered) => Promise<{ clean: boolean; entries: ReadonlyArray<CheckEntry> }>` | Byte-compares against `.git/hooks`.                                               |
| `install`           | `(root, rendered) => Promise<{ wrote: ReadonlyArray<string> }>`                       | Installs the rendered scripts.                                                    |
| `CheckEntry`        | `{ file: string; status: "clean" \| "stale" \| "missing" }`                           | One hook file's classification.                                                   |
| `hookNames`         | `readonly ["preCommit", "postCommit", "prePush", "postMerge"]`                        | The workspace hook events, in render order.                                       |
| `HookName`          | `(typeof hookNames)[number]`                                                          | One hook event.                                                                   |
| `hookFiles`         | `Readonly<Record<HookName, string>>`                                                  | The git hook file each event installs to.                                         |
| `LabelResolver`     | `{ labelOf(target): string \| undefined }`                                            | The one fact rendering needs from the index.                                      |
| `GitHooksError`     | class carrying `code`                                                                 | One typed refusal.                                                                |
| `isGitHooksError`   | `(value: unknown) => value is GitHooksError`                                          | Guard.                                                                            |
| `ErrorCode`         | union                                                                                 | `unlabeled_hook_target`, `invalid_label`, `not_a_git_repository`, `write_failed`. |

## GithubRender

The `Github.CiGen` implementation. From `@smthrs/build-cli/GithubRender`.

| Export                | Signature                                                          | What it is                                                                                    |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `render`              | `(options: { ciGen; workspace; resolve; packageDir }) => CiRender` | The complete file set one target owns.                                                        |
| `check`               | `(root, rendered) => Promise<CheckReport>`                         | Byte-compares the set against the tree.                                                       |
| `write`               | `(root, rendered) => Promise<WriteReport>`                         | Publishes the set, atomically per file.                                                       |
| `CiRender`            | `{ label; packageDir; files; preserve; changes }`                  | One rendered output.                                                                          |
| `RenderedFile`        | `{ path: string; content: string }`                                | One rendered file.                                                                            |
| `CheckReport`         | `{ clean: boolean; entries: ReadonlyArray<CheckEntry> }`           | The drift report.                                                                             |
| `CheckEntry`          | `{ path: string; status: FileStatus }`                             | One classified file row.                                                                      |
| `FileStatus`          | `"clean" \| "stale" \| "missing" \| "unexpected" \| "preserved"`   | One file's classification.                                                                    |
| `WriteReport`         | `{ wrote; unchanged; removed; preserved }`                         | The result of publishing.                                                                     |
| `LabelResolver`       | `{ labelOf(target); targets?() }`                                  | What the renderer needs from the index.                                                       |
| `GithubRenderError`   | class carrying `code`                                              | One typed refusal.                                                                            |
| `isGithubRenderError` | `(value: unknown) => value is GithubRenderError`                   | Guard.                                                                                        |
| `ErrorCode`           | union of fifteen codes                                             | From `unlabeled_cigen` and `duplicate_job_id` through `outside_write_set` and `write_failed`. |

## MemoryBackend

Retaining facts in the declared Smithers Cloud banks. From
`@smthrs/build-cli/MemoryBackend`.

| Export                                                                             | Signature                                                             | What it is                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `retain`                                                                           | `(options: RetainOptions) => Promise<RetainResult>`                   | Retains the referenced commit in the declared banks.          |
| `RetainOptions`                                                                    | `{ root; target; memory; locator?; cli?; resolveSource? }`            | One retain's inputs.                                          |
| `RetainResult`                                                                     | `{ binary: string; facts: ReadonlyArray<RetainedFact> }`              | The binary that ran and the facts it wrote.                   |
| `RetainedFact`                                                                     | `{ namespace; key; args; stdout }`                                    | One written fact.                                             |
| `CliLocator`                                                                       | `{ find(): Promise<string \| undefined> }`                            | Finds the `smithers` binary.                                  |
| `pathLocator`                                                                      | `(environment) => CliLocator`                                         | The default locator: scans `PATH`.                            |
| `MemoryCli`                                                                        | `{ run(binary, args, cwd) => Promise<{ exitCode; stdout; stderr }> }` | Runs one backend invocation.                                  |
| `spawnCli`                                                                         | `(options?: SpawnCliOptions) => MemoryCli`                            | The default runner; spawns with no shell.                     |
| `SpawnCliOptions`                                                                  | `{ timeoutMs?: number }`                                              | Its one option.                                               |
| `memoryCliCommands`                                                                | `ReadonlyArray<string>`                                               | The subcommands `smithers memory` ships.                      |
| `parseMemoryHelpCommands`                                                          | `(help: string) => ReadonlyArray<string>`                             | Parses the `Commands:` section of its help output.            |
| `assertMemoryCliCommand`                                                           | `(subcommand: string) => void`                                        | Asserts a subcommand is in the shipped surface.               |
| `MemoryBackendUnavailable`                                                         | class carrying `code`                                                 | `no_backend_declared` or `cli_not_found`.                     |
| `MemoryCapabilityMissing`                                                          | class carrying `capability`                                           | A required operation has no counterpart in the installed CLI. |
| `MemoryCommandFailed`                                                              | class carrying `exitCode`, `stdout`, `stderr`, `args`                 | The backend ran and refused.                                  |
| `isMemoryBackendUnavailable`, `isMemoryCapabilityMissing`, `isMemoryCommandFailed` | guards                                                                | One per error class.                                          |

## RspackRunner

Bundler targets, run through the workspace's own bundler. From
`@smthrs/build-cli/RspackRunner`.

| Export             | Signature                                                               | What it is                                      |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `resolveGraph`     | `(options: RunnerOptions, payload) => Effect<ResolveResult, ExecError>` | Resolves one module graph.                      |
| `runBuild`         | `(options: RunnerOptions, payload) => Effect<Exec.Result, ExecError>`   | Runs one build for one environment and mode.    |
| `ResolveLive`      | `(options: RunnerOptions) => Layer`                                     | Implements the bundler-resolve action.          |
| `BuildLive`        | `(options: RunnerOptions) => Layer`                                     | Implements the bundler-build action.            |
| `RunnerOptions`    | `{ workspaceRoot; scratchDirectory; timeoutMs? }`                       | Host wiring for one runner.                     |
| `defaultTimeoutMs` | `15 * 60 * 1000`                                                        | Wall-clock bound for one bundler child process. |

## WorkspaceToolchain

Workspace declaration resolution, from `@smthrs/build-cli/WorkspaceToolchain`.

| Export                                   | Contract                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `WorkspaceToolchain`                     | The resolved `runtime` and `packageManager`, either of which may be absent.                     |
| `ResolvedWorkspaceToolchain`             | A `WorkspaceToolchain` with sorted `manifestDigests: ReadonlyArray<Input.FileDigest>`.          |
| `of(workspace)`                          | Reads literal declarations without I/O; leaves manifest-derived requirements unresolved.        |
| `resolve(workspace, { root, signal? })`  | Returns `Promise<ResolvedWorkspaceToolchain>` after resolving declared manifests within `root`. |
| `fill(workspaceAttrs, attrs, toolchain)` | Fills only named, omitted attrs; preserves explicit target declarations.                        |

`resolve` reads `engines.node` and the pnpm `packageManager` pin from declared
manifests. An explicit pnpm version wins while its manifest is still read and
measured. Each manifest is bounded at 1 MiB, decoded as strict UTF-8, and must be
a JSON object inside the workspace. The same validated text supplies both its
requirements and digest; equivalent paths are read once per resolution. Missing
or invalid pins, unsupported version syntax, path escapes, and cancellation
refuse resolution. No tool is installed or executed by this resolver.

From `@smthrs/build-cli/engine`, `TargetToolchain` carries the tools one
action-backed target uses. `targetToolchain(target, attrs)` selects them from
validated attrs without probing. `verifyTargetToolchain(toolchain, cwd,
environment, sensitiveEnvironment?)` is an Effect requiring a
`ChildProcessSpawner`; it verifies the selected runtime and manager in the
target's directory and tool environment before execution. It performs no
install or fetch. `PnpmWorkspace` and `GithubCiGen` only render declarations and
need no tool probe; an explicit Bun Vitest runtime selects Bun as its runner.
The package planner verifies native `Runtime.bin` references and
`PackageManager.bin` references with a resolved Node/Bun toolchain. These checks
do not change legacy Yarn lowering or guarantee the
interpreter chosen by an arbitrary custom package-manager launcher.

For native `Runtime.npx` references under Node, the planner keys both the
JavaScript launcher bytes and its bounded `--version` result (exit code and
output), executed by the selected Node in the same restricted environment and
workspace directory. Runtime and launcher version probes are distinct even
though they use the same executable; identical executable/argument probes are
shared within a plan. This measures a changed reported implementation version
behind an unchanged launcher, without claiming to hash every transitive import.

## Modules outside the barrel

Every one of these is importable as `@smthrs/build-cli/<Module>`. The barrel
leaves them out because a host reaches them through the modules above rather
than driving them directly.

| Module                                                                                                                     | What it holds                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Cli`                                                                                                                      | `makeCli`, `cli`, `normalizeArgv`, `RuntimeConfig`.                     |
| `Entry`                                                                                                                    | `Host` and `main`.                                                      |
| `engine`                                                                                                                   | The install adapter and its layers.                                     |
| `Cache`                                                                                                                    | The result cache and the content-addressed store.                       |
| `PackageDiscovery`, `PackageLoader`, `PackageIndex`                                                                        | Discovery, declaration loading, and the validated index.                |
| `PackageExec`                                                                                                              | The build executor: plan, execute, run.                                 |
| `PackageTree`                                                                                                              | Write-set confinement, the gitignored census, and the ceilings.         |
| `Executor`                                                                                                                 | `Summary`, `TargetReport`, `mergePlans`, `describeFailure`.             |
| `Owners`                                                                                                                   | Ownership resolution and the generated `CODEOWNERS` and `OWNERS` files. |
| `GraphOutput`                                                                                                              | Text-tree and Mermaid rendering of a graph.                             |
| `Diagnostic`                                                                                                               | Bounded rendering of a failure into text.                               |
| `Ansi`                                                                                                                     | Palette selection and the environment it reads.                         |
| `RepoResolution`                                                                                                           | Resolving a `Repo.Target` through a child CLI.                          |
| `WorkspaceLoader`, `WorkspaceToolchain`                                                                                    | Reading the workspace declaration and its toolchain.                    |
| `TargetExecution`                                                                                                          | The per-target execution boundary.                                      |
| `Environment`                                                                                                              | The ambient environment a run reads.                                    |
| `PackageError`                                                                                                             | The typed discovery and index refusals.                                 |
| `MarkdownCodeBlocks`                                                                                                       | The `Markdown.CodeBlocks` rule implementation.                          |
| `DockerExec`, `FetchExec`, `FoundryExec`, `GitSubmoduleExec`, `GoExec`, `NixExec`, `OverlayExec`, `StampExec`, `AnvilExec` | One rule family's execution each.                                       |

`OverlayExec.apply` confines replacement sources and destinations to the canonical
scratch root. It refuses destination directory symlinks, dangling destination
links, and file links that resolve outside scratch, including absolute links back
to the original workspace. An internal destination file link is replaced with a
regular file without changing its target. Replacement files are staged beside the
destination and renamed into place.
