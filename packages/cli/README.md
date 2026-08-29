# @smthrs/cli

Node command-line projection of the flows control plane. It turns `@smthrs/control` operations into the `flows` executable and supplies the Node HTTP, WebSocket, and output layers used by the CLI host.

```sh
npm install @smthrs/cli
```

## Public API

The root entry point exports the following namespaces; each is also available from `@smthrs/cli/<Module>`.

| Module          | Public exports                                                                                                                                                                                                                                                                                                                    | Description                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Application`   | `Config`, `layer`                                                                                                                                                                                                                                                                                                                 | Selects the local or authenticated RPC-backed Control layer from transport-neutral configuration.                   |
| `CliError`      | `UsageError`, `UnsupportedError`, `CliError`, `exitCode`                                                                                                                                                                                                                                                                          | Defines typed CLI failures and their stable process exit codes.                                                     |
| `Command`       | `cli`                                                                                                                                                                                                                                                                                                                             | Exposes the Effect CLI command tree.                                                                                |
| `Forensics`     | `Refusal`, `Digest`, `digest`, `renderDiagnosis`, `renderTranscript`, `eventLine`                                                                                                                                                                                                                                                 | Projects a run's watch events into the transcript and diagnosis renderings.                                         |
| `NodeControl`   | `Environment`, `ServerOptions`, `EngineDurable`, `makeConfig`, `config`, `projectSources`, `layerRegistry`, `databasePath`, `executionDatabasePath`, `engineDurable`, `seatResolver`, `layerSeatResolver`, `layerExecutor`, `layerControl`, `layerOutput`, `layer`, `layerServer`, `layerServerBearerAuth`, `layerServerNoopAuth` | Assembles Node configuration, Control, the production run executor, output, and loopback-default RPC server layers. |
| `Output`        | `Format`, `Rendered`, `Service`, `Output`, `make`, `layer`, `exitCode`                                                                                                                                                                                                                                                            | Renders deterministic human or JSON output through an injectable service.                                           |
| `Verb`          | `Verb`, `verbs`, `find`                                                                                                                                                                                                                                                                                                           | Provides reserved system-flow verb metadata and lookup.                                                             |
| `Version`       | `packageVersion`                                                                                                                                                                                                                                                                                                                  | Exposes the version declared by the installed `@smthrs/cli` package metadata.                                       |
| `bin` / `flows` | side-effect entry point                                                                                                                                                                                                                                                                                                           | Runs `Command.cli`; the package also installs it as the `flows` executable.                                         |

```ts
import { Command, NodeControl, Version } from "@smthrs/cli"
import { Effect } from "effect"
import { Command as Cli } from "effect/unstable/cli"

const config = NodeControl.makeConfig([
  "--remote",
  "http://127.0.0.1:3000",
  "--credential",
  "alpha-secret"
])

const main = Cli.run(Command.cli, { version: Version.packageVersion }).pipe(
  Effect.provide(NodeControl.layer(config))
)
```

`@smthrs/cli/package.json` is exported for package metadata. `internal/*` and nested `*/index` subpaths are not public.

Control servers bind `127.0.0.1` by default. See the [control-plane trust posture](../../docs/guides/control-plane-trust.md) before opting into a non-loopback bind.

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

2. Export the provider key for the seat's provider — `ANTHROPIC_API_KEY` for
   `anthropic:*` seats, `OPENAI_API_KEY` for `openai:*` seats. A missing key
   refuses the launch with a typed `LaunchFailed` naming the variable.

3. Run it and watch the run settle:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   approval="$(flows --json plan hello | jq -c '.approval')"
   flows --json approve "$approval" --scope run
   flows --json run "$approval"
   flows ps
   flows logs <run-id> --follow
   ```

   `flows run` prints the accepted receipt with the run id; `flows ps` shows
   the durable run state. A run that asks for approval parks as
   `waiting-approval` and journals a `control.approval.requested` event whose
   `payload` field is the exact argument for `flows approve '<payload>'`;
   `flows run --resume <run-id>` then re-drives the parked execution.
