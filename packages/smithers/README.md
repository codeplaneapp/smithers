# @smthrs/cli

This package declares `effect`, `@effect/platform-node`, and `@effect/platform-node-shared` as exact
`4.0.0-rc.108` peer dependencies. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://cli.smithers.sh

Node command-line projection of the Smithers control plane. It turns `@smthrs/control` operations into the `smthrs` executable (with `smithers` as an alias) and supplies the Node HTTP, WebSocket, and output layers used by the CLI host.

```sh
npm install @smthrs/cli
```

## Public API

The root entry point exports the following namespaces; each is also available from `@smthrs/cli/<Module>`.

| Module              | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Description                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Agents`            | `serverName`, `Agent`, `agents`, `find`, `launchCommand`, `Wired`, `addMcp`, `manualInstructions`                                                                                                                                                                                                                                                                                                                                                                                                                                            | The agent configurations `mcp add` writes the Smithers MCP server into.                                                   |
| `Application`       | `Config`, `Engine`, `engineMemory`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Selects the local or authenticated RPC-backed Control layer from transport-neutral configuration.                         |
| `Bug`               | `defaultEndpoint`, `scrubText`, `scrub`, `Report`, `report`, `timeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Scrubs and posts a `smthrs bug` report.                                                                                   |
| `ClaudeMirror`      | `contract`, `subscriptionTtlMs`, `subscriptionsPath`, `Subscription`, `readSubscriptions`, `subscribe`, `unsubscribe`, `MirrorNode`, `Frame`, `defaultMaxOutputChars`, `frame`, `terminalStatuses`, `isTerminal`, `Transition`, `notableKinds`, `transition`                                                                                                                                                                                                                                                                                 | The Claude Code plugin mirror protocol: subscriptions, frames, and status transitions.                                    |
| `CliError`          | `UsageError`, `UnsupportedError`, `ResourceLimitError`, `RenderingError`, `CliError`, `exitCode`                                                                                                                                                                                                                                                                                                                                                                                                                                             | Typed CLI failures and their stable process exit codes.                                                                   |
| `CodexAuth`         | `refreshUrl`, `clientId`, `locate`, `parse`, `Store`, `MakeOptions`, `make`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Locates and refreshes the Codex credential store.                                                                         |
| `Command`           | `latestSequence`, `signalKey`, `cli`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The Effect CLI command tree.                                                                                              |
| `Detached`          | `admissionVariable`, `defaultTimeoutMs`, `defaultTerminationGraceMs`, `admissionLine`, `admittedRunId`, `logTail`, `terminate`, `Launched`, `Rejected`, `Options`, `launch`, `discard`, `isLaunched`                                                                                                                                                                                                                                                                                                                                         | Launches `up -d`, and reads the admission line its child prints.                                                          |
| `Doctor`            | `Level`, `Check`, `Report`, `minimumNode`, `satisfiesNode`, `Options`, `inspect`, `render`, `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                         | Registry, database, runtime, and provider readiness as one report.                                                        |
| `Environment`       | `Name`, `names`, `Source`, `ambientWorkingDirectory`, `read`, `readInteger`, `unsupportedBackendMessage`, `unsupportedBackend`                                                                                                                                                                                                                                                                                                                                                                                                               | The closed `SMITHERS_*` set rc.0 reads, with the four `FLOWS_*` aliases.                                                  |
| `ExecutorOwnership` | `ExecutorOwnership`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Whether this process owns the executor that settles accepted runs.                                                        |
| `Forensics`         | `Refusal`, `Digest`, `digest`, `shellQuote`, `renderDiagnosis`, `eventLine`, `renderTranscript`                                                                                                                                                                                                                                                                                                                                                                                                                                              | Projects a run's watch events into the transcript and diagnosis renderings.                                               |
| `Gc`                | `defaultRetention`, `duration`, `databases`, `Failure`, `Sweep`, `sweep`, `failureMessage`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The retention pass over a project's databases, and what it could not open.                                                |
| `Init`              | `ignoreRule`, `IgnoreStatus`, `isRepository`, `ensureIgnored`, `Seat`, `defaultSeat`, `template`, `Scaffolded`, `nameProblem`, `isValidName`, `scaffold`, `defaultName`                                                                                                                                                                                                                                                                                                                                                                      | Scaffolds `flows/<name>/flow.mdx` and ignores `.flows/`.                                                                  |
| `Legacy`            | `terminalStatuses`, `Run`, `Database`, `read`, `refusal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Reads a 0.x `smithers.db` read-only for the 0.x-project guard.                                                            |
| `McpServer`         | `protocolVersion`, `maximumFrameBytes`, `maximumHistoryEvents`, `maximumHistoryBytes`, `Surface`, `Envelope`, `succeeded`, `failed`, `Tool`, `supportedTools`, `unsupportedReasons`, `unsupportedTools`, `rawTools`, `Options`, `tools`, `requested`, `optionsFromArguments`, `respond`, `serve`                                                                                                                                                                                                                                             | The stdio MCP server: its tool tables and its `{ ok, data?, error? }` envelope.                                           |
| `NodeControl`       | `Environment`, `ServerOptions`, `makeConfig`, `config`, `projectSources`, `layerHostPlatform`, `layerGrantStore`, `layerGuardedPlatform`, `layerObserver`, `layerRegistry`, `databasePath`, `executionDatabasePath`, `EngineDurable`, `engineDurable`, `seatResolver`, `layerSeatResolver`, `testRunner`, `checkpointStore`, `testFlows`, `rebuildableTransport`, `layerExecutor`, `layerControl`, `layerOutput`, `layer`, `layerMemoryRemote`, `layerMemory`, `layerServer`, `layerGateway`, `layerServerBearerAuth`, `layerServerNoopAuth` | Assembles Node configuration, Control, the run executor, output, and the served gateway.                                  |
| `NodeOutput`        | `resultNodeId`, `Node`, `project`, `find`, `notFound`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Reads one registered node output from the node-output projection.                                                         |
| `Output`            | `Format`, `Rendered`, `Service`, `Output`, `renderValue`, `maximumDepth`, `maximumMembers`, `maximumOutputBytes`, `make`, `layer`, `exitCode`                                                                                                                                                                                                                                                                                                                                                                                                | Renders deterministic human or JSON output through an injectable service.                                                 |
| `Project`           | `legacyMarkers`, `root`, `legacyRoot`, `stateDirectory`, `logDirectory`, `logFile`, `flowsDirectory`, `legacyDatabases`, `legacyState`, `legacyNotice`, `ProjectRoot`, `LegacyState`, `MigrationRoot`, `layer`                                                                                                                                                                                                                                                                                                                               | Resolves the rc.0 project root, the 0.x root `migrate` converts, the state directories, and the 0.x state beside them.    |
| `Providers`         | `order`, `compatible`, `compatibleKey`, `defaultSeat`, `detect`, `NoSeatError`, `SeatSyntaxError`, `noSeatMessage`, `chooseSeat`                                                                                                                                                                                                                                                                                                                                                                                                             | Which model seats this machine can run `smthrs suggest` on, and which one it runs.                                        |
| `Serve`             | `loopbackHosts`, `defaultBind`, `Mount`, `mounts`, `isLoopback`, `Bind`, `GatewayHost`, `refuse`, `workspaceHash`, `health`, `banner`, `host`                                                                                                                                                                                                                                                                                                                                                                                                | The gateway bind rule, the mount list, and the banner rendered from it.                                                   |
| `Suggest`           | `Implementation`, `Outcome`, `exitStatus`, `Implement`, `Options`, `isDirectory`, `suggestionDocument`, `seatDocument`, `outcomeDocument`, `introLine`, `streamLabel`, `wroteNote`, `run`                                                                                                                                                                                                                                                                                                                                                    | Reads the project, streams the ways Smithers can help, and implements the one picked.                                     |
| `Ui`                | `brand`, `Check`, `Spinner`, `StreamOptions`, `Streamed`, `PickOptions`, `ConfirmOptions`, `Service`, `Ui`, `Options`, `isInteractive`, `make`, `renderChecklist`, `layer`, `current`                                                                                                                                                                                                                                                                                                                                                        | Interactive human rendering: brand line, log lines, spinners, streamed suggestions, prompts, and the plain-line fallback. |
| `Unsupported`       | `migrationUrl`, `RemovedVerb`, `removedVerbs`, `RemovedFlag`, `removedFlags`, `message`, `flagMessage`, `verbError`, `refusal`, `isReservedFlow`, `reservedFlowError`, `flagError`, `findFlag`                                                                                                                                                                                                                                                                                                                                               | The removal surface: removed verbs, removed flags, reserved flow ids.                                                     |
| `Update`            | `packageName`, `registryUrl`, `Status`, `isNewer`, `compare`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Compares the installed version with the registry's latest.                                                                |
| `Verb`              | `Verb`, `shipped`, `subcommands`, `names`, `find`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The shipped verb catalog and lookup.                                                                                      |
| `Version`           | `packageVersion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The version declared by the installed `@smthrs/cli` package metadata.                                                     |
| `bin` / `smthrs`    | side-effect entry point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Runs `Command.cli`; the package also installs it as the `smthrs` executable, with `smithers` as an alias.                 |

```ts
import { Command, NodeControl, Version } from "@smthrs/cli"
import { Effect } from "effect"
import { Command as Cli } from "effect/unstable/cli"

const config = NodeControl.makeConfig(
  ["--remote", "http://127.0.0.1:3000"],
  process.env,
  process.cwd()
)

const main = Cli.run(Command.cli, { version: Version.packageVersion }).pipe(
  Effect.provide(NodeControl.layer(config))
)
```

`@smthrs/cli/package.json` is exported for package metadata. `internal/*` and nested `*/index` subpaths are not public.

Control servers bind `127.0.0.1` by default. See the [control-plane guide](https://smithers.sh/docs/guides/control-plane/) before opting into a non-loopback bind.

`SMITHERS_API_KEY` is the preferred credential channel. The compatibility
flag `--credential` warns on stderr, even under `--quiet`, because argv is
visible in process listings and may remain in shell history.

## Exit codes

`smthrs` uses one status vocabulary, so a script can branch on it.

| Code  | Meaning                                                                               |
| ----- | ------------------------------------------------------------------------------------- |
| `0`   | The command did what it was asked.                                                    |
| `1`   | The command failed, or the run it reports settled `failed`.                           |
| `2`   | The invocation was wrong. Retype the command; the message names the flag or argument. |
| `3`   | The run is parked at `waiting-approval`. Answer it with `smthrs approve` and resume.  |
| `130` | The run was cancelled or interrupted.                                                 |
| `143` | The run was terminated.                                                               |

Codes 3, 130, and 143 report a run outcome rather than a failure of the command, and are decided from the control receipt alone. See [the CLI reference](https://smithers.sh/docs/reference/cli/) for the per-verb detail.

## Environment

rc.0 reads a closed set of variables, all listed by `Environment.names`, with four `FLOWS_*` aliases retained from the import. The ones an operator sets most often:

| Variable                                 | Meaning                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `SMITHERS_REMOTE`                        | Fallback for `--remote`.                                          |
| `SMITHERS_API_KEY`                       | Preferred credential channel; avoids argv exposure.               |
| `SMITHERS_MCP_CONFIG`                    | Fallback for `--mcp-config`.                                      |
| `SMITHERS_BACKEND`                       | SQLite only. Any other value exits 1 with `unsupported_database`. |
| `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS` | How long `up -d` waits for its child to report admission.         |

Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`) are read by the seat resolver, not by the CLI itself. `smthrs doctor` reports which are present.

## MCP

`smthrs --mcp` serves the Smithers MCP server on stdio, so an agent drives runs through the same control plane the verbs do. `smthrs mcp add --agent <id>` writes the server entry into one agent's configuration, and `smthrs mcp add` with no `--agent` writes it into every agent the CLI knows: `claude` and `codex`.

The server answers a `{ ok, data?, error? }` envelope on every tool. Ten of the twenty-one 0.x tools answer `{ ok: false, error: { code: "unsupported" } }` in rc.0; `McpServer.unsupportedTools` names them and `McpServer.unsupportedReasons` says why. Reserved `system/*` flows are not listed and cannot be launched, matching `smthrs up` and `smthrs ls`.

Each MCP request and response frame is limited to 4 MiB. One MCP history result is limited to 10,000 events and 1 MiB. Crossing either boundary returns `RESOURCE_LIMIT`; an oversized input line is discarded incrementally before JSON decoding.

`--mcp-config <path>` is the other direction: it connects MCP servers the local executor projects into a run's flow catalog. It is meaningless against `--remote`, where the executor is not this process's to configure.

## Resource bounds

Finite CLI history projections retain at most 50,000 events and 16 MiB, with a 1 MiB per-event cap. Follow mode applies the per-event cap without retaining prior events. Rendered output accepts at most 128 nested levels, 10,000 data members, and 4 MiB of UTF-8 output. Exceeding a bound fails with a typed resource or rendering error instead of truncating or executing caller-owned objects.

## Manual smoke: run an agent flow with a real key

The local composition executes approved agent flows through the production
executor and the SQLite-backed `@smthrs/flows/NodeRuntime`. To verify
against a real provider:

1. Create a markdown prompt flow in the project:

   ```sh
   mkdir -p flows/hello
   cat > flows/hello/flow.mdx <<'EOF'
   ---
   description: Replies with one short greeting sentence.
   model: anthropic:claude-sonnet-4-5
   ---
   Reply with one short greeting sentence, then complete with that sentence
   as your output.
   EOF
   ```

2. Export the provider key for the seat's provider: `ANTHROPIC_API_KEY` for
   `anthropic:*` seats, `OPENAI_API_KEY` for `openai:*` seats. A missing key
   refuses the launch with a typed `LaunchFailed` naming the variable.

3. Run it and watch the run settle:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   approval="$(smthrs --json plan hello | jq -c '.approval')"
   smthrs --json approve "$approval" --scope run
   smthrs --json run "$approval"
   smthrs ps
   smthrs logs <run-id> --follow
   ```

   `smthrs run` prints the accepted receipt with the run id; `smthrs ps` shows
   the durable run state. A run that asks for approval parks as
   `waiting-approval` and journals a `control.approval.requested` event whose
   `payload` field is the exact argument for `smthrs approve '<payload>'`;
   `smthrs run --resume <run-id>` then re-drives the parked execution.
