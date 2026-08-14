# First-class sandbox provider plugins: Daytona, Cloudflare, Vercel, AWS, GCP

Status: DESIGN (merged best-of-both from an Opus design and a Codex design).
Scope: add first-class sandbox provider packages for Daytona, Vercel, AWS, and
GCP, keep Cloudflare on the same path, and extract a shared provider-kit so each
vendor is a thin adapter. No new `SandboxRuntime` enum value is added.

Grounding: `packages/sandbox/src/*` (execute.js, transport.js, SandboxProvider.ts,
egress.js, bundle.js), the shipped provider packages, and
`.smithers/specs/cloud-execution-engineering.md` Part 5.

---

## 1. Architecture decision

All five cloud backends use the JS `SandboxProvider` object-registry path
(`{ id, run(request), cleanup?(request) }`), never the Effect `SandboxTransport`
runtime path. `SandboxRuntime` stays exactly
`"bubblewrap" | "docker" | "codeplane" | "cloudflare"`. This is mandated by the
engineering spec and enforced by `check-docs.mjs`. The transport path drives
local, in-process isolation; a remote cloud sandbox runs the command on the
remote machine with the SDK as the only transport, which is exactly what
`run(request) -> SandboxProviderResult` models.

Each backend ships as `packages/<provider>` mirroring `@smthrs/cloudflare`:

- a factory `create<Provider>SandboxProvider(options)` returning a `SandboxProvider`
- an exported provider-id constant (`<PROVIDER>_SANDBOX_PROVIDER_ID`)
- a `register<Provider>SandboxProvider(options)` convenience (construct + register + return unregister)
- a `createMock<Provider>SandboxEnvironment()` in-memory SDK double for CI-safe tests
- the heavy cloud SDK as an `optionalDependency`, lazily `import()`-ed inside `run()`
- a re-export from `packages/smithers/src/<provider>.js` + a `./<provider>` subpath export
- docs written before code, folded into the llms bundles

### 1.1 Shared provider-kit (in `packages/sandbox`)

Extract the request/result-file protocol into `packages/sandbox/src/provider-kit/`. A provider
author implements a small `SandboxSession`, not a `run()` from scratch.

```ts
// packages/sandbox/src/provider-kit/SandboxSession.ts
export type SandboxSession = {
  readonly remoteId: string;                 // source of remoteRunId / workspaceId / containerId
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly exec: (command: string, opts: SandboxExecOptions) => Promise<SandboxExecResult>;
  readonly destroy?: () => Promise<void>;
};
export type SandboxExecOptions = { cwd: string; env: Record<string,string>; timeoutMs: number; signal?: AbortSignal };
export type SandboxExecResult = { exitCode: number; stdout: string; stderr: string };
```

`createCommandSandboxProvider({ id, command, workdir, requestFile, resultFile, env, createSession, cleanup })`
is the single copy of the protocol:

1. `session = await createSession(request)` (vendor-specific)
2. `heartbeat({ stage: "<id>-session-created", remoteId: session.remoteId })`
3. write request JSON to `requestFile` — only the safe fields:
   `{ runId, sandboxId, input, config, allowNetwork, maxOutputBytes, egress: redactedEgressMeta }`
4. merge env: `{ ...options.env, ...sandboxEgressEnv(request.egress), SMITHERS_SANDBOX_REQUEST_PATH, SMITHERS_SANDBOX_RESULT_PATH }`
   (never copy arbitrary `process.env`)
5. `res = await session.exec(command, { cwd: workdir, env, timeoutMs: request.toolTimeoutMs, signal: request.signal })`
6. nonzero exit with no valid result JSON -> throw `SmithersError("SANDBOX_EXECUTION_FAILED", ..., { provider: id })`
   with stdout/stderr truncated to `maxOutputBytes` and redacted
7. `raw = res.stdout.trimStart().startsWith("{") ? res.stdout : await session.readFile(resultFile)`
8. `return parseSandboxProviderResult(raw, session.remoteId)` — fills `remoteRunId`/`workspaceId`/`containerId` when omitted
9. `cleanup(request)` resolves the cached session and `await session.destroy?.()` per policy

Kit files (one export each):
`SandboxSession.ts`, `SandboxProviderCommandOptions.ts`, `createCommandSandboxProvider.js`,
`writeSandboxProviderRequestFile.js`, `parseSandboxProviderResult.js`,
`uploadEgressCaToSession.js`, `redactSandboxProviderValue.js`,
`createSandboxProviderContractSuite.js`, `SANDBOX_PROVIDER_REQUEST_ENV.js`,
`SANDBOX_PROVIDER_RESULT_ENV.js`, `index.js` (barrel). Re-export the kit from
`packages/sandbox/src/index.js`.

Cloudflare is refactored onto the kit in the same change. The
Cloudflare `execution:"process"` long-running branch stays a Cloudflare-only path
outside the kit. The existing `packages/cloudflare/tests` are the frozen contract
and must pass unchanged.

### 1.2 Redaction & egress

`redactSandboxProviderValue(value)` redacts keys containing
`token|secret|key|password|credential|authorization` plus provider-specific names,
applied to every thrown message, heartbeat payload, and the `configJson` audit row.
`request.egress` is already normalized; the kit projects it to env via the existing
`sandboxEgressEnv()` and, when `caCertPem` is set, `uploadEgressCaToSession()` uploads
the CA to the workspace path so `NODE_EXTRA_CA_CERTS` resolves inside the sandbox.
Credentials come from the vendor SDK's standard local discovery (factory options win,
env is the zero-config fallback) and are never placed in the remote request JSON or
forwarded to the remote env unless the user explicitly lists them in `options.env`.

### 1.3 Shared factory option semantics (aligned across providers)

`id?`, `command?` (default `node /workspace/run-smithers-sandbox.js`),
`workdir?` (default `/workspace`; Vercel `/vercel/sandbox`), `env?`, `setupFiles?`,
`cleanup?: "destroy" | "keep"` (default `"destroy"`), `sandboxId?(request)` (default
`` `${request.runId}-${request.sandboxId}` ``), `client?` (inject an SDK double / preconfigured client),
`clientOptions?`, `timeoutMs?` (default `request.toolTimeoutMs`). Provider packages add
their own required knobs (region, bucket, cluster, project, image, resources).

---

## 2. Per-provider design

Common in-sandbox contract: the entry command reads `SMITHERS_SANDBOX_REQUEST_PATH`
and writes a `SandboxProviderResult` JSON to `SMITHERS_SANDBOX_RESULT_PATH`
(`{ bundlePath }` or `{ status, output|outputs, patches?, artifacts?, diffBundle?, runId? }`),
or prints the result JSON to stdout.

### 2.1 Daytona — `@smthrs/daytona` (id `daytona-sandbox`)
SDK `@daytonaio/sdk` (lazy import; also try `@daytona/sdk` rename). `new Daytona({ apiKey, apiUrl, target })`,
env `DAYTONA_API_KEY`/`DAYTONA_API_URL`/`DAYTONA_TARGET`. `daytona.create({ image|snapshot, envVars, labels, ephemeral, autoStopInterval, resources })`;
ship via `sandbox.fs.uploadFile`, exec via `sandbox.process.executeCommand(command, workdir, env, timeout)` ->
`{ exitCode, result }` (streams merged), collect via `sandbox.fs.downloadFile`. Cleanup `daytona.delete`
(skip on `keep`). Default `autoStopInterval: 15`, `ephemeral: true`.

### 2.2 Cloudflare — `@smthrs/cloudflare` (id `cloudflare-sandbox`, EXISTS)
Refactor `run()`/`cleanup()` onto `createCommandSandboxProvider`, preserving public options,
result shape, the Durable Object binding requirement, `keepAlive`, and the `execution:"process"` branch.
Add contract-suite + validation + redaction tests. D1/DO-SQLite descriptor helpers stay separate.

### 2.3 Vercel — `@smthrs/vercel` (id `vercel-sandbox`)
SDK `@vercel/sandbox`. `Sandbox.create({ runtime, source?, resources:{vcpus}, ports?, timeout, env })`.
Auth OIDC (`VERCEL_OIDC_TOKEN`) preferred, access-token fallback (`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`).
Ship via `sandbox.writeFiles([{path, content:Buffer, mode?}])` under `/vercel/sandbox`; exec `sandbox.runCommand({cmd,args,cwd,env})` ->
`.exitCode`/`await .stdout()`; collect `sandbox.readFile({path})`. Cleanup `delete()` default, `stop()` for `persistence:"sticky"`.
Default session timeout 5 min; `extendTimeout(ms)` up to plan cap (45 min Hobby / 5 h Pro) — warn past cap, error only beyond it.
`sandbox.domain(port)` surfaced in result `output` when ports declared.

### 2.4 AWS — `@smthrs/aws` (id `aws-sandbox`, single factory + `mode`)
`createAwsSandboxProvider({ mode: "fargate" | "codebuild", region, bucket, ... })`, default `mode:"fargate"`.
Bundle transport is BYO S3 (`createAwsSandboxS3Transport` over `@aws-sdk/client-s3`): request ->
`s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/request.json`, result read back from `<prefix>/sandbox-result.json`.
Auth = standard AWS credential chain; never inject local creds into the container (task/build IAM role).
- `mode:"fargate"` (`createAwsEcsSandboxRunner`, `@aws-sdk/client-ecs`): `RunTask` with `launchType:"FARGATE"`,
  `awsvpcConfiguration` (subnets/securityGroups/assignPublicIp) required, `containerOverrides` (command + env incl. S3 URIs + egress);
  `waitUntilTasksStopped` -> `DescribeTasks` -> `containers[0].exitCode` (real numeric exit). Cleanup `StopTask` if running; `containerId` = task ARN.
- `mode:"codebuild"` (`createAwsCodeBuildSandboxRunner`, `@aws-sdk/client-codebuild`): `StartBuild` with S3 source/artifacts +
  `buildspecOverride` + env; poll `BatchGetBuilds`; `SUCCEEDED`->finished else failed (coarse status, no numeric exit). Cleanup `StopBuild`.
CloudWatch logs (`@aws-sdk/client-cloudwatch-logs`) only when enabled, truncated to `maxOutputBytes`.
Prereqs (cluster/task-def/VPC/bucket/IAM) are documented, not auto-provisioned. EC2 mode is documented future work.

### 2.5 GCP — `@smthrs/gcp` (id `gcp-sandbox`)
`createGcpSandboxProvider({ projectId, location, bucket, jobName, ... })`, default Cloud Run Jobs
(`createGcpCloudRunJobsSandboxRunner`, `@google-cloud/run` v2 `JobsClient`). Bundle transport via GCS
(`createGcpSandboxGcsTransport`, `@google-cloud/storage`). Auth = ADC (`GOOGLE_APPLICATION_CREDENTIALS` / workload identity).
Ensure/reuse Job, `runJob({ overrides: { containerOverrides:[{env,args}], timeout }})` -> LRO -> `Execution`;
success = `succeededCount===1`; failure -> failed result. Cleanup deletes transient GCS objects and per-run Job if created.
Cloud Run has no numeric exit code (task counts / conditions). Compute Engine mode is documented future work.

---

## 3. Registration & config selection

1. **Provider object (primary)**: `<Sandbox provider={createDaytonaSandboxProvider({...})} workflow={...} />`.
2. **Registered id**: `registerSandboxProvider(createVercelSandboxProvider({...}))` then `<Sandbox provider="vercel-sandbox" />`.
3. **Env default (stretch, well-tested)**: `SMITHERS_SANDBOX_PROVIDER=daytona-sandbox` selects a **registered** id only
   (it never auto-creates cloud clients). Precedence mirrors the DB-backend chain: explicit prop -> workflow config ->
   `SMITHERS_SANDBOX_PROVIDER` -> local default. If env selection adds meaningful risk to the `Sandbox` component/graph
   extraction, ship it as a follow-up commit and document the precedence now.

Credentials: factory options > vendor env chain; never required in `request.config`. `SandboxProps.provider`
is already `unknown` and `runtime` is the closed legacy enum — no component type change needed, only JSDoc/doc examples.

---

## 4. File layout

### 4.1 Shared kit (existing `packages/sandbox`)
`src/provider-kit/{SandboxSession.ts, SandboxProviderCommandOptions.ts, createCommandSandboxProvider.js,
writeSandboxProviderRequestFile.js, parseSandboxProviderResult.js, uploadEgressCaToSession.js,
redactSandboxProviderValue.js, createSandboxProviderContractSuite.js, SANDBOX_PROVIDER_REQUEST_ENV.js,
SANDBOX_PROVIDER_RESULT_ENV.js, index.js}`; add `export * from "./provider-kit/index.js"` to `src/index.js`;
document in `src/README.md`.

### 4.2 New provider packages (mirror `packages/cloudflare`)
Each: `package.json` (SDK optionalDependency; deps `@smthrs/sandbox` + `@smthrs/errors`),
`src/index.js` barrel, `src/README.md`, `tests/`. Files per §2 with one export each:
- `packages/daytona/src/`: `DAYTONA_SANDBOX_PROVIDER_ID.js`, `DaytonaSandboxProviderOptions.ts`,
  `createDaytonaSandboxProvider.js`, `registerDaytonaSandboxProvider.js`, `createMockDaytonaSandboxEnvironment.js`, `index.js`
- `packages/vercel/src/`: analogous
- `packages/aws/src/`: `AWS_SANDBOX_PROVIDER_ID.js`, `AwsSandboxProviderOptions.ts`, `createAwsSandboxProvider.js`,
  `createAwsSandboxS3Transport.js`, `createAwsEcsSandboxRunner.js`, `createAwsCodeBuildSandboxRunner.js`,
  `registerAwsSandboxProvider.js`, `createMockAwsSandboxEnvironment.js`, `index.js`
- `packages/gcp/src/`: `GCP_SANDBOX_PROVIDER_ID.js`, `GcpSandboxProviderOptions.ts`, `createGcpSandboxProvider.js`,
  `createGcpSandboxGcsTransport.js`, `createGcpCloudRunJobsSandboxRunner.js`, `registerGcpSandboxProvider.js`,
  `createMockGcpSandboxEnvironment.js`, `index.js`

### 4.3 Meta-package re-exports (`packages/smithers`)
`src/{daytona,vercel,aws,gcp}.js` each `export * from "@smthrs/<provider>"`; add `./daytona`, `./vercel`,
`./aws`, `./gcp` subpath exports + workspace deps to `packages/smithers/package.json` (mirror the `./cloudflare` shim).

### 4.4 Docs (Mintlify `.mdx`; land BEFORE code)
`docs/components/sandbox-providers.mdx` (shared: contract, kit, registration, egress/secrets),
`docs/integrations/{daytona,vercel,aws,gcp}-sandbox-provider.mdx`, update `docs/components/sandbox.mdx` provider list,
add nav in `docs/docs.json`, add the 5 mdx paths to the `scripts/generate-llms.ts` manifest, add coverage asserts to
`scripts/check-docs.mjs`. Regenerate with `pnpm docs:llms` (updates
`docs/llms-*.txt` + mirrored bundles under `apps/cli/docs/`, `packages/smithers/docs/`, `skills/smithers/`).
CI gates on `check-docs` / `check-llms`.

---

## 5. Test plan (bun test; mock doubles in CI, live e2e gated)

### 5.1 Shared provider-kit unit tests (`packages/sandbox/tests/provider-kit.test.js`)
request JSON contents; env injection (request/result paths + egress env, no arbitrary process.env); stdout-JSON vs
result-file parsing; `{bundlePath}` and `{status,outputs}` passthrough with remote-id fill; nonzero-exit throws with
truncated+redacted stderr; empty/malformed result throws; `toolTimeoutMs`+`signal` forwarding; egress projection;
`uploadEgressCaToSession` only when `caCertPem` set; redaction of creds in messages/heartbeats; cleanup resolves+destroys,
missing session no-op; `createCommandSandboxProvider` rejects empty id/command.

### 5.2 Shared contract suite (`createSandboxProviderContractSuite`) — every provider imports it
Parameterized `{ name, createProvider(mockHandler), createRequest?, expectedProviderId }`. Asserts (30 cases): expected id;
finished/failed/cancelled/bundlePath results passthrough; remoteRunId/workspaceId/containerId fill; request JSON has
runId/sandboxId/input/config + allowNetwork/maxOutputBytes/sanitized egress; sets both SMITHERS_SANDBOX_*_PATH; merges
options.env; does not copy unrelated process.env; heartbeat create/ready/command/result stages; respects toolTimeoutMs;
invalid/empty result rejects; nonzero exit without result rejects; stdout/stderr truncated to maxOutputBytes; cleanup
destroy vs keep; cleanup idempotent; cleanup after failed run still attempts; signal cancellation stops remote; deterministic
cancellation error; redaction of secret env in errors + heartbeats; mock records uploaded files; mock blocks exec after destroy.
Result shapes validated against the real `__executeSandboxInternals.materializeProviderResult`.

### 5.3 Per-provider unit tests (mock environment, CI-safe)
Each package: default+custom id; empty command rejected; invalid cleanup rejected; injected client used; client built from
options/env when absent; missing-credential produces a clear construction error without network; sandboxId default+custom;
create receives image/snapshot/resources/provider options; waits-for-ready; setup files before request JSON; request JSON
content; command env includes Smithers paths; stdout + result-file parse; invalid JSON throws with redaction; create/exec/
upload failures surfaced+redacted; cleanup destroy vs keep; cancellation stops+cleans; `allowNetwork:false` selects restricted
profile; egress in request; secret redaction; heartbeat ordering. Plus the mock-environment's own tests (deterministic ids,
stores files, blocks exec after destroy, fault injection). Plus transport tests: AWS `createAwsSandboxS3Transport` +
`createAwsEcsSandboxRunner` + `createAwsCodeBuildSandboxRunner`; GCP `createGcpSandboxGcsTransport` +
`createGcpCloudRunJobsSandboxRunner` (build valid request, poll to terminal, map exit/status, cancel). AWS runs the contract
suite in both fargate and codebuild mock modes; GCP in Cloud Run mode.

### 5.4 Registry & config tests (`packages/sandbox/tests`)
register-by-id; duplicate-id semantics documented+asserted; resolve id/object; unknown id throws listing registered ids;
`<Sandbox provider="id">` vs object bypass; `SMITHERS_SANDBOX_PROVIDER` selects registered id; explicit prop wins;
env default never instantiates cloud providers; provider config reaches `request.config`. (Env-selection tests gate on
whether the stretch item ships in this change.)

### 5.5 Failure injection (deterministic via mocks, per provider)
create throws before remote id; ready-poll timeout; setup-upload fail; request-upload fail; command-start fail; nonzero exit;
timeout; missing result file; invalid result JSON; unknown `status`; oversized result rejected by `validateSandboxBundle`;
both `bundlePath` and `status` present -> rejected/documented; cleanup destroy fails after success (downgraded to warning per
execute.js, result preserved) + after failure; cancellation during create/upload/exec/download; SDK error containing a secret
is redacted; heartbeat callback throws -> deterministic behavior; result diffBundle flows through the diff-review gate
(`SandboxDiffReviewRequested`, blocked when `autoAcceptDiffs:false`).

### 5.6 Live e2e (gated, NOT in default CI)
One smoke per provider under `e2e/` guarded by `test.skipIf(!creds)`: create -> ship trivial request -> run runner ->
collect `{status:"finished", output}` -> cleanup, asserting no orphan workspace/task/execution/build remains. Env guards:
`SMITHERS_LIVE_DAYTONA_TESTS`+`DAYTONA_API_KEY`; `SMITHERS_LIVE_VERCEL_TESTS`+OIDC/token; `SMITHERS_LIVE_AWS_TESTS`+chain+
`SMITHERS_E2E_AWS_*`; `SMITHERS_LIVE_GCP_TESTS`+ADC+`SMITHERS_E2E_GCP_*`. Live tests print which env vars are missing when skipped.
CI (no creds, no browsers) runs only §5.1-5.5 + docs checks + typecheck.

---

## 6. Risks / open questions (with decisions)

1. Kit refactor must preserve Cloudflare's exact options/result shape + `execution:"process"` branch — land kit + Cloudflare
   refactor as one reviewed commit; existing Cloudflare tests are the frozen contract.
2. No true exit code on CodeBuild/Cloud Run — DECISION: infra failure (no result written) -> throw; result-file `status:"failed"`
   -> normal failed bundle through `finalizeSandboxBundle`.
3. BYO S3/GCS bucket on AWS/GCP — DECISION: require a pre-existing bucket (document IAM), auto-manage only the key prefix + short object TTL.
4. Vercel plan duration caps — DECISION: warn + `extendTimeout` up to the cap, error only past it.
5. Package proliferation (5 packages + 5 re-exports, release/CI surface) — DECISION: per-vendor packages (matches Cloudflare
   precedent, keeps each SDK optional and independently versionable); accept the release-surface cost; update publish.mjs
   drift guards + dependency-boundary checks.
6. Redaction completeness — per-package allowlist covered by a test asserting no secret leaks into `configJson`, events, or messages.
7. `SMITHERS_SANDBOX_PROVIDER` implementation site (component vs CLI bootstrap) — DECISION: registered-id resolution only,
   shipped as a small stretch commit or deferred; document precedence now.
8. Nested cloud sandboxes remain unsupported in v1 (document); the `sandboxExecutionContext` depth guard is unchanged.
