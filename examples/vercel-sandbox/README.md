# Vercel Sandbox provider example

[Vercel Sandbox](https://vercel.com/docs/sandbox) runs arbitrary code in isolated, ephemeral Firecracker microVMs, directly integrated with the Vercel platform (auth via Vercel OIDC tokens or access tokens, `Sandbox.create({ source: { type: "git", ... } })`, up to 24 hours of runtime on Pro/Enterprise). Use it when you want your agent's remote sandbox to live on the same platform as the rest of your deployment (Vercel Cron, Vercel Functions, etc.) rather than a separate VM provider.

This example shows the sandbox-provider shape for a Vercel Sandbox integration.

`provider.ts` exports `createVercelSandboxProvider()`, which implements the Smithers `SandboxProvider` contract. It creates a sandbox with `Sandbox.create()`, writes setup and request files with `sandbox.writeFiles()`, runs a command with `sandbox.runCommand()`, reads a result JSON file with `sandbox.readFileToBuffer()`, and returns a Smithers sandbox result bundle. `cleanup()` calls `sandbox.stop()` even when the run throws, so a failed or aborted run doesn't leave a sandbox (and its billing) running.

`workflow.tsx` uses a mock `@vercel/sandbox`-shaped client so the example typechecks and runs without credentials. To use the real SDK:

```ts
import { Sandbox } from "@vercel/sandbox";
import { createVercelSandboxProvider } from "./provider.js";

const vercelSandboxProvider = createVercelSandboxProvider({
  // Sandbox.create has the same (options) => Promise<SandboxHandle> shape
  // this provider expects, so the real class can be passed directly.
  vercelSandbox: { create: (options) => Sandbox.create(options) },
  runtime: "node24",
  timeout: 5 * 60 * 1000,
  createOptions: {
    source: { type: "git", url: "https://github.com/your-org/your-repo.git" },
  },
  setupFiles: {
    "/vercel/sandbox/run-smithers-sandbox.js": {
      content: "...write /vercel/sandbox/smithers-result.json here...",
    },
  },
});
```

`@vercel/sandbox` is an **optional peer dependency** of this example — it is never a dependency of any core Smithers package. Install it yourself (`pnpm add @vercel/sandbox`) and authenticate with `vercel link && vercel env pull` (local dev) or `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` (external CI/CD, non-Vercel hosts). See [Sandbox Authentication](https://vercel.com/docs/sandbox/concepts/authentication).

The remote command must write `/vercel/sandbox/smithers-result.json` as JSON:

```json
{
  "status": "finished",
  "output": { "summary": "done" },
  "runId": "remote-run-id",
  "diffBundle": {
    "seq": 1,
    "baseRef": "HEAD",
    "patches": []
  }
}
```

Smithers validates the returned bundle, records sandbox lifecycle events, and applies `diffBundle` only when review policy allows it.

## Verified API facts

The provider is written against the real `@vercel/sandbox` JS SDK (confirmed via `https://vercel.com/docs/sandbox` and `https://vercel.com/docs/sandbox/sdk-reference`, and `https://vercel.com/docs/sandbox/concepts/authentication`, all fetched 2026-07-01), not guessed from training data:

- `Sandbox.create({ name?, source?, runtime?, timeout?, env?, resources?, ... })` — `source` can be `{ type: "git", url, username?, password?, depth?, revision? }`, `{ type: "tarball", url }`, or `{ type: "snapshot", snapshotId }`. `timeout` is in milliseconds and defaults to 5 minutes; the max configurable duration was extended over time (45 min on Hobby, up to 24 hours on Pro/Enterprise as of this writing — verify current limits on your plan).
- `sandbox.runCommand({ cmd, args?, cwd?, env?, sudo?, detached?, stdout?, stderr? })` returns a `CommandFinished` (blocking) or `Command` (detached) with `.exitCode`, `.stdout()`, `.stderr()`, `.logs()` (async-iterable `{ stream, data }`), and `.kill(signal?)`.
- `sandbox.writeFiles([{ path, content: Buffer, mode? }])` and `sandbox.readFileToBuffer({ path, cwd? })` (resolves `null` if missing).
- `sandbox.stop()` resolves once the VM is fully stopped and is safe to call multiple times.
- Auth: `VERCEL_OIDC_TOKEN` (via `vercel link && vercel env pull` locally, automatic on Vercel) or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` (access-token auth for external CI/non-Vercel hosts).
