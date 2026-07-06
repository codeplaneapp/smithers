# @smithers-orchestrator/daytona — src

Smithers `SandboxProvider` backed by the [Daytona](https://www.daytona.io/) SDK.
It runs a Smithers sandbox request inside a Daytona sandbox: uploads
`.smithers/sandbox-request.json` into the workdir, runs the entry command, then
reads the result JSON from stdout or `.smithers/sandbox-result.json` (paths are
handed to the command via `SMITHERS_SANDBOX_REQUEST_PATH` /
`SMITHERS_SANDBOX_RESULT_PATH`). The shared provider-kit owns that protocol,
egress, secret scrubbing, and cleanup — this package only maps the small
`SandboxSession` seam onto Daytona.

## Exports

- `createDaytonaSandboxProvider(options?)` — build the provider.
- `registerDaytonaSandboxProvider(options?)` — build + register in the global
  registry; returns the unregister function.
- `createMockDaytonaSandboxEnvironment(handler, faults?)` — in-memory SDK double
  for tests (zero credentials).
- `DAYTONA_SANDBOX_PROVIDER_ID` — `"daytona-sandbox"`.

## Prerequisites / env vars

`@daytonaio/sdk` is an **optionalDependency**, imported lazily inside
`createSession` (the package also tries the renamed `@daytona/sdk`). Install it
to use the real provider:

```
npm install @daytonaio/sdk
```

The client is constructed from `options.clientOptions` / `options.apiKey` etc.,
falling back to env vars:

- `DAYTONA_API_KEY` — API key (required for a real client).
- `DAYTONA_API_URL` — API base url (optional).
- `DAYTONA_TARGET` — target region (optional).

## Usage

```js
import { registerDaytonaSandboxProvider } from "@smithers-orchestrator/daytona";

const unregister = registerDaytonaSandboxProvider({
	image: "ubuntu:22.04",
	autoStopInterval: 15, // minutes idle before Daytona auto-stops
	ephemeral: true,      // delete the sandbox on disconnect
});
```

Then point a workflow `<Sandbox provider="daytona-sandbox">` at it. Per-run
`request.config` may carry `image`, `snapshot`, `resources`, `labels`, or a
`workspace` block (`snapshotId`, `idleTimeoutSecs`, `persistence:"ephemeral"`)
which maps onto the Daytona create options.

## SDK subset used

`daytona.create({ image?|snapshot?, envVars, labels, ephemeral,
autoStopInterval, resources })`, `sandbox.fs.uploadFile(Buffer, path)`,
`sandbox.fs.downloadFile(path)`, `sandbox.process.executeCommand(command, cwd,
env, timeoutSecs)` (Daytona merges stderr into `result`), and
`daytona.delete(sandbox)`.

## Cleanup / cost

`cleanup: "destroy"` (default) deletes the sandbox after the run; `"keep"`
leaves it. `ephemeral` + `autoStopInterval` bound idle cost even if cleanup is
skipped. `src/index.d.ts` is the committed public type surface — keep it in
sync with the exports.
