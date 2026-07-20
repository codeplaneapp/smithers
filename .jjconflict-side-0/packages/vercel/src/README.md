# @smithers-orchestrator/vercel — src

A Smithers `SandboxProvider` backed by the [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
SDK. It runs a workflow's sandbox request on Vercel Sandbox compute: ships
`.smithers/sandbox-request.json` into the sandbox workdir, runs the entry
command, and reads the result JSON from stdout or
`.smithers/sandbox-result.json`.

Built on top of `createCommandSandboxProvider` from
`@smithers-orchestrator/sandbox`, so request shipping, egress, result parsing,
secret scrubbing, and cleanup are handled uniformly; this package only supplies
the Vercel `createSession` seam.

## Exports

- `createVercelSandboxProvider(options)` — build the provider.
- `registerVercelSandboxProvider(options)` — build + register; returns the
  unregister function.
- `createMockVercelSandboxEnvironment(handler, config?)` — in-memory SDK double
  for tests (pass as `options.client`); implements the Vercel SDK subset used
  here.
- `VERCEL_SANDBOX_PROVIDER_ID` — the provider id (`"vercel-sandbox"`).

## Auth (never forwarded into the remote command env)

OIDC is preferred; the access-token trio is the fallback:

- `VERCEL_OIDC_TOKEN` (preferred), or
- `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.

Each can be passed via options (`oidcToken`, `token`, `teamId`, `projectId`).
Missing auth throws `INVALID_INPUT` before the SDK is touched.

## Usage

```jsx
import { registerVercelSandboxProvider } from "@smithers-orchestrator/vercel";

const unregister = registerVercelSandboxProvider({
	runtime: "node24",
	vcpus: 2,
	ports: [3000],
	maxDurationMs: 45 * 60_000,
});

// <Sandbox provider="vercel-sandbox"> … </Sandbox>
```

## Duration & plan cap

The default session timeout is 5 minutes (also Vercel's create-time ceiling).
`options.timeoutMs` (or `request.toolTimeoutMs`) maps to the create `timeout`.
Durations above the 5-minute ceiling are reached by warning via a heartbeat and
calling `sandbox.extendTimeout()`, up to `options.maxDurationMs` (default 45
minutes). A request above the cap throws `INVALID_INPUT`.

## Cleanup / cost

Ephemeral sandboxes are **deleted** permanently on teardown (`cleanup:
"destroy"`, the default). Set `persist: true` to `stop()` (pause) the sandbox
instead so it can be resumed. `cleanup: "keep"` skips teardown entirely.

## Gotchas

- `@vercel/sandbox` is an `optionalDependency`, imported lazily inside
  `createSession`, so the package loads without it. Tests use the mock only and
  never import the real SDK.
- `src/index.d.ts` is generated-but-committed — never hand-edit it.
