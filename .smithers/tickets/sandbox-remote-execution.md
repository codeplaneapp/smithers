# `<Sandbox>` — isolated task execution via Airlock bundles

## Problem

Smithers runs everything in-process on the host machine. For tasks that need
isolation (untrusted code, heavy compute, different environments) or parallelism
across machines, there's no way to run work in a sandboxed environment and collect
results safely.

The existing `<Subflow mode="childRun">` and `<Worktree>` components provide logical
and filesystem isolation, but no process or network isolation.

## Proposal

Add a `<Sandbox>` component with three backends:

| Backend | Runs on | Isolation level | Use case |
|---------|---------|----------------|----------|
| **Bubblewrap** (default) | Same machine | Linux namespaces (pid, net, mount, ipc) | Untrusted agents, safe default |
| **Docker** | Same machine | Container (full filesystem + network isolation) | Reproducible environments, custom images |
| **Codeplane** | Remote service | Full VM workspace | Heavy compute, GPU, long-running, multi-machine |

Results come back as Airlock-style bundles: tarballs with structured JSON output +
diffs/patches + logs.

## Prerequisites

1. Extract or standardize a shared child-workflow execution primitive that both
   builder/effect workflows and JSX/runtime subflows can use.
2. Land transactional state writes for sandbox ship/receive/accept mutations.
3. Define and validate a bundle manifest format before adding real transports.
4. Add task heartbeats/checkpoints before treating remote execution as resumable.

### Workflow code

```tsx
// Default: bubblewrap on same machine
<Sandbox id="analyze" output={outputs.analysis}>
  <Task id="scan" agent={securityAgent} output={outputs.scan}>
    Scan the codebase for vulnerabilities
  </Task>
</Sandbox>

// Docker: custom image, same machine
<Sandbox id="build" runtime="docker" image="node:22-slim" output={outputs.build}>
  <Task id="compile" output={outputs.compiled}>
    Run the build
  </Task>
</Sandbox>

// Codeplane: remote VM workspace
<Sandbox id="gpu-work" runtime="codeplane" workspace={workspaces.gpu} output={outputs.result}>
  <Task id="train" agent={mlAgent} output={outputs.model}>
    Fine-tune the model
  </Task>
</Sandbox>
```

### Runtime configuration

```tsx
// Bubblewrap (default) — no config needed, or:
<Sandbox id="safe" runtime="bubblewrap" allowNetwork={false}>

// Docker — mirrors Codeplane's CreateContainerConfig
<Sandbox id="build" runtime="docker" image="node:22-slim"
  env={{ NODE_ENV: "production" }}
  memoryLimit="2g"
  cpuLimit="2.0"
  volumes={[{ host: "./fixtures", container: "/data", readonly: true }]}>

// Codeplane — workspace spec matching the Codeplane API
<Sandbox id="gpu" runtime="codeplane" workspace={{
  name: "gpu-training",
  snapshotId: "snap_node22_cuda",     // optional: restore from snapshot
  idleTimeoutSecs: 1800,              // 30 min default
  persistence: "ephemeral",           // auto-cleanup when done
}}>
```

## Backends

### Bubblewrap (default)

Bubblewrap (`bwrap`) provides lightweight Linux namespace isolation without root.
On macOS, falls back to `sandbox-exec` (already used by Smithers' bash tool for
network blocking).

- PID namespace: sandbox can't see/signal host processes
- Network namespace: no network by default (`allowNetwork: false`)
- Mount namespace: read-only root, writable tmpdir for workspace
- IPC namespace: isolated shared memory
- Bind-mounts the workflow bundle into the sandbox
- `smithers up bundle.tsx` runs inside the namespace
- On completion, collects the Airlock bundle from the writable workspace dir

### Docker

Uses the Docker daemon on the same machine. Configuration mirrors Codeplane's
`CreateContainerConfig`:

- `image`: container image (default: `ghcr.io/codeplane-ai/workspace:latest`)
- `env`: environment variables
- `ports`: port mappings
- `volumes`: bind mounts (host path → container path, readonly flag)
- `memoryLimit`, `cpuLimit`: resource constraints
- `command`: override (default: `smithers up bundle.tsx`)
- Healthcheck: wait for container to be ready before shipping bundle

Lifecycle: `docker create` → `docker start` → ship bundle via `docker cp` →
`docker exec smithers up bundle.tsx` → collect bundle via `docker cp` →
`docker rm`.

### Codeplane (remote)

Codeplane (formerly JJHub) provides full VM workspaces via API. This is the only
backend that runs on a separate machine.

Workspace lifecycle matches the Codeplane API:

1. **Create workspace**: `POST /api/repos/:owner/:repo/workspaces`
   with name, optional `snapshot_id`, `idle_timeout_secs`, `persistence`
2. **Wait for healthy**: poll workspace status until `running`
3. **Get SSH info**: `GET /api/repos/:owner/:repo/workspaces/:id/ssh`
4. **Ship bundle**: `scp` bundle tarball to workspace via SSH
5. **Execute**: `ssh <workspace> smithers up bundle.tsx`
6. **Heartbeat**: poll workspace activity or stream via SSE
   (`GET /api/repos/:owner/:repo/workspaces/:id/stream`)
7. **Collect bundle**: `scp` result bundle back from workspace
8. **Cleanup**: `DELETE /api/repos/:owner/:repo/workspaces/:id` (if ephemeral)
   or `POST .../suspend` (if sticky)

Supports Codeplane-specific features:
- **Snapshots**: restore from a pre-built environment (`snapshotId`)
- **Forking**: fork an existing workspace for parallel work
- **Suspend/resume**: pause workspace between tasks (preserves disk)
- **Idle timeout**: auto-suspend after inactivity

## Execution model (all backends)

1. **Pack**: Serialize the Sandbox subtree (workflow fragment + inputs + context) into
   an Airlock bundle. This is a self-contained smithers workflow.
2. **Ship**: Transfer the bundle into the sandbox (bind-mount for bwrap, docker cp for
   Docker, scp for Codeplane)
3. **Execute**: `smithers up bundle.tsx` inside the sandbox — a normal Smithers run
4. **Heartbeat**: Sandbox process heartbeats back to orchestrator (see
   task-heartbeats ticket)
5. **Return**: On completion, package results as an Airlock bundle:
   - `README.md` with structured JSON output (task outputs)
   - `patches/*.patch` if files were modified
   - `logs/stream.ndjson` (Smithers event log from sandbox execution)
   - `artifacts/` (any additional files)
6. **Review & Accept**: Orchestrator receives bundle, validates outputs against
   schemas, applies diffs if approved, stores outputs in parent run's tables

### Bundle format (Airlock-compatible)

```
bundle.tar.gz/
  README.md          # JSON structured output: { outputs: {...}, status: "finished" }
  patches/
    0001-fix-xss.patch
    0002-add-tests.patch
  artifacts/
    analysis-report.json
    coverage.html
  logs/
    stream.ndjson    # Smithers event log from sandbox execution
```

### Review gate

By default, diffs from a Sandbox require approval before being applied to the host
filesystem (Airlock's core principle: "sandboxes shouldn't have write access to the
host").

```tsx
<Sandbox id="trusted-build" autoAcceptDiffs={true}>  {/* skip review */}
<Sandbox id="untrusted-agent" reviewDiffs={true}>     {/* require approval (default) */}
```

The approval gate reuses the existing `<Approval>` component infrastructure.

### Signals integration

Signals can eventually unify sandbox communication, but they should not block the
MVP. The first version can use explicit transport callbacks/polling for:
- Sandbox → Host: heartbeats, intermediate results, completion bundles
- Host → Sandbox: cancellation and approval outcomes

## Rollout phases

### Phase 1: Bubblewrap sandbox

- Implement bubblewrap backend (bwrap on Linux, sandbox-exec fallback on macOS)
- Bundle pack/unpack with manifest validation
- Output collection and schema validation
- Diff review gate via Approval

### Phase 2: Docker sandbox

- Docker backend using Codeplane's `CreateContainerConfig` shape
- Resource limits (memory, CPU)
- Custom images and volume mounts
- Same bundle protocol as bubblewrap

### Phase 3: Codeplane remote workspaces

- Codeplane API client (workspace create/execute/collect/cleanup)
- SSH-based bundle transfer
- SSE status streaming
- Snapshot support for fast environment setup
- Suspend/resume for long-running sandboxes

### Phase 4: Streaming and bidirectional control

- Multiple intermediate bundles
- Heartbeat/checkpoint-based retries
- Optional signal-based host/sandbox communication

## Additional Steps

1. Define a bundle manifest schema and validate it before unpacking anything.
2. Add path sanitization and size-limit enforcement before diff/artifact extraction.
3. Create a `SandboxTransport` interface with bubblewrap as first implementation.
4. Record sandbox lifecycle rows/events in `_smithers_sandboxes`.
5. Add a clear parent/child run relationship for sandbox runs.
6. For Docker: auto-detect Docker daemon availability, fall back to bubblewrap.
7. For Codeplane: read API endpoint and auth from env vars or config
   (`CODEPLANE_API_URL`, `CODEPLANE_API_KEY`).
8. Test bwrap availability at startup; if not installed, provide install instructions
   or fall back to `sandbox-exec` on macOS.

### Schema additions

```sql
CREATE TABLE _smithers_sandboxes (
  run_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'bubblewrap',  -- bubblewrap | docker | codeplane
  remote_run_id TEXT,             -- runId inside the sandbox
  workspace_id TEXT,              -- Codeplane workspace ID (if applicable)
  container_id TEXT,              -- Docker container ID (if applicable)
  config_json TEXT NOT NULL,      -- runtime-specific configuration
  status TEXT NOT NULL DEFAULT 'pending',
  shipped_at_ms INTEGER,
  completed_at_ms INTEGER,
  bundle_path TEXT,               -- local path to received bundle
  PRIMARY KEY (run_id, sandbox_id)
);
```

## Verification requirements

### E2E tests

1. **Bubblewrap sandbox** — `<Sandbox>` with default runtime. Assert child workflow
   runs in a namespace-isolated process, completes, bundle is created, outputs are
   written to parent run's tables.

2. **Bubblewrap network isolation** — Sandbox runs a task that tries `curl`. Assert
   network access is blocked by default. With `allowNetwork={true}`, assert it works.

3. **Docker sandbox** — `<Sandbox runtime="docker" image="node:22-slim">`. Assert
   container is created, workflow runs inside it, bundle collected, container cleaned
   up.

4. **Docker resource limits** — `<Sandbox runtime="docker" memoryLimit="256m">`.
   Assert container has the memory limit applied (inspect container config).

5. **Codeplane sandbox** — `<Sandbox runtime="codeplane" workspace={spec}>`. Assert
   workspace is created via Codeplane API, workflow runs via SSH, bundle collected,
   workspace cleaned up.

6. **Codeplane snapshot restore** — Workspace with `snapshotId`. Assert workspace is
   restored from snapshot (faster start) rather than cold-starting.

7. **Bundle format** — Assert the bundle tarball contains: `README.md` with valid JSON
   outputs, `logs/stream.ndjson` with child events, and `patches/*.patch` if files
   were modified.

8. **Output schema validation** — Sandbox returns JSON that doesn't match parent's
   output schema. Assert validation error, bundle is rejected, run enters retry or
   failure.

9. **Diff review gate** — Sandbox produces file diffs. With `reviewDiffs={true}`
   (default), assert run enters `waiting-approval` with the diff shown. Approve →
   diffs applied. Deny → diffs discarded, task marked failed.

10. **Auto-accept diffs** — `<Sandbox autoAcceptDiffs={true}>`. Assert diffs are
    applied without approval gate.

11. **Sandbox failure** — Sandboxed `smithers up` fails. Assert error propagates to
    parent run. Retry policy applies.

12. **Heartbeat integration** — Sandbox heartbeats during execution. Assert
    `_smithers_attempts.heartbeat_at_ms` is updated. If heartbeats stop, task times
    out and retries.

13. **Cancellation propagation** — Cancel parent run. Assert sandbox process/container/
    workspace is terminated.

14. **Sandbox with dependencies** — `<Task id="prep" /><Sandbox deps={[outputs.prep]}>`.
    Assert sandbox receives prep output as input context.

15. **macOS fallback** — On macOS (no bwrap), assert bubblewrap runtime falls back to
    `sandbox-exec` with network denial profile.

### Corner cases

16. **bwrap not installed** — On Linux without bubblewrap installed. Assert clear error
    with install instructions, not a cryptic spawn failure.

17. **Docker daemon not running** — Runtime is "docker" but daemon is down. Assert
    clear error "Docker daemon not reachable".

18. **Codeplane API unreachable** — Assert transport error with backoff retry.

19. **Malicious bundle** — Bundle contains path traversal in patch paths
    (`../../etc/passwd`). Assert paths are sanitized, traversal is rejected.

20. **Bundle too large** — Bundle tarball exceeds 100MB. Assert rejection.

21. **Nested sandboxes** — `<Sandbox><Sandbox>...</Sandbox></Sandbox>`. Inner sandbox
    uses a different runtime. Assert both complete.

22. **Codeplane workspace idle timeout** — Workspace goes idle mid-execution. Assert
    Smithers detects the suspension and either resumes or retries.

### Size limits

23. **Max bundle size**: 100MB tarball.
24. **Max README.md output JSON**: 5MB.
25. **Max patches per bundle**: 1000 files.
26. **Max concurrent sandboxes per run**: Configurable, default 10.

## Observability

### New events
- `SandboxCreated { runId, sandboxId, runtime, configJson, timestampMs }`
- `SandboxShipped { runId, sandboxId, runtime, bundleSizeBytes, timestampMs }`
- `SandboxHeartbeat { runId, sandboxId, remoteRunId, progress, timestampMs }`
- `SandboxBundleReceived { runId, sandboxId, bundleSizeBytes, patchCount, hasOutputs, timestampMs }`
- `SandboxCompleted { runId, sandboxId, remoteRunId, runtime, status, durationMs, timestampMs }`
- `SandboxFailed { runId, sandboxId, runtime, error, timestampMs }`
- `SandboxDiffReviewRequested { runId, sandboxId, patchCount, totalDiffLines, timestampMs }`
- `SandboxDiffAccepted { runId, sandboxId, patchCount, timestampMs }`
- `SandboxDiffRejected { runId, sandboxId, reason, timestampMs }`

### New metrics
- `smithers.sandbox.created_total` (counter, label: runtime) — sandboxes created
- `smithers.sandbox.completed_total` (counter, label: runtime, status) — completed/failed
- `smithers.sandbox.active` (gauge, label: runtime) — currently executing
- `smithers.sandbox.duration_ms` (histogram, durationBuckets) — end-to-end time
- `smithers.sandbox.bundle_size_bytes` (histogram, sizeBuckets) — bundle sizes
- `smithers.sandbox.transport_duration_ms` (histogram, durationBuckets) — ship/receive
- `smithers.sandbox.patch_count` (histogram) — patches per bundle

### Logging
- `Effect.withLogSpan("sandbox:create")`, `sandbox:pack`, `sandbox:ship`,
  `sandbox:execute`, `sandbox:receive`, `sandbox:review`, `sandbox:apply`,
  `sandbox:cleanup`
- Annotate with `{ runId, sandboxId, runtime, containerId?, workspaceId? }`

## Codebase context

### Smithers files
- `src/components/Subflow.ts:1-57` — **Primary reference**: Sandbox extends Subflow
  with `mode="childRun"`. The scheduler already treats childRun as a single task node
  (`src/engine/scheduler.ts:166-178`).
- `src/components/Worktree.ts` — Filesystem isolation component. On bundle return,
  diffs are applied to parent worktree using the same mechanisms.
- `src/tools/utils.ts` — `resolveSandboxPath()` and `assertPathWithinRootEffect()`:
  existing path traversal prevention. Reuse for bundle patch path sanitization.
- `src/tools/bash.ts` — macOS `sandbox-exec` integration for network blocking.
  Reference for the macOS bubblewrap fallback.
- `src/cli/index.ts:371-419` — Detached spawning logic. Bubblewrap/Docker sandbox
  execution generalizes this: wrap `spawn` with namespace/container isolation.
- `src/engine/index.ts:2197-2235` — `computeFn` execution path for Subflow. Sandbox
  replaces this with: create sandbox → pack → ship → execute → collect → validate.
- `src/components/Approval.ts` — Diff review gate reuses this component.
- `src/events.ts:10-164` — EventBus; sandbox events forwarded back should be
  persisted with `source: "sandbox:<id>"` annotation.
- `src/effect/child-process.ts` — `spawnCaptureEffect()` for process spawning;
  bubblewrap wraps this with `bwrap` prefix args.
- `tests/tools-sandbox-path.test.ts` — Path traversal prevention tests. Same
  patterns needed for bundle patch path validation.
- `tests/tools-bash-network.test.ts` — Network isolation tests. Reference for
  bubblewrap/sandbox-exec network blocking assertions.

### Codeplane reference (for Codeplane backend)
- `codeplane/packages/sdk/src/services/container-sandbox.ts` — Docker/Podman sandbox
  client: `createVM()`, `startVM()`, `suspendVM()`, `removeVM()`, `execInVM()`,
  `waitForHealthy()`. The Docker backend should match this API shape.
- `codeplane/packages/sdk/src/services/workspace.ts` — WorkspaceService:
  `createWorkspace()`, `suspendWorkspace()`, `resumeWorkspace()`,
  `deleteWorkspace()`, `forkWorkspace()`, `createWorkspaceSnapshot()`. The Codeplane
  backend wraps this service.
- `codeplane/packages/sdk/src/services/workspace.Dockerfile` — Default workspace
  image (Ubuntu 24.04 + git + jj + bun + sshd). Docker backend can use this as
  default image.
- `codeplane/apps/server/src/routes/workspaces.ts` — HTTP route handlers for
  workspace CRUD, SSH info, suspend/resume, fork, snapshot.
- `codeplane/apps/server/src/services.ts` — Service initialization showing how
  `ContainerSandboxClient` is configured with runtime detection
  (`CODEPLANE_CONTAINER_RUNTIME`).
- `jjhub/db/schema.sql` — Workspace/session DB schema. Reference for
  `_smithers_sandboxes` table design (status enum, idle tracking, snapshot refs).
- `jjhub/db/queries/workspace.sql` — `ListIdleWorkspaces`,
  `ListStalePendingWorkspaces` queries. Reference for sandbox lifecycle monitoring.

### Temporal reference
- `temporal-reference/service/history/transfer_queue_active_task_executor.go` — How
  Temporal dispatches tasks to workers and collects results.
- `temporal-reference/tests/activity_test.go:1181` — Heartbeat details during retry:
  applicable to sandbox heartbeat → checkpoint → retry pattern.

## Effect.ts architecture

### Boundary rule

All internal code MUST stay in Effect. Never call `runPromise()` or `runSync()` inside
internal modules. The only places allowed to break out of Effect into promises are:

- **CLI command handlers** — the outermost `run(c)` function in `src/cli/index.ts`
- **HTTP route handlers** — the outermost handler in `src/server/index.ts`
- **JSX component boundaries** — React/Solid components that call into Effect services
- **Test entry points** — `Effect.runPromise` in test files

Everything else — DB queries, engine logic, transport calls, validation, metrics,
logging — must compose as `Effect<A, E, R>` and flow through the Effect pipeline.
Do not wrap Effect code in `runPromise()` to get a Promise, then re-wrap that Promise
in `Effect.tryPromise()`. Keep the Effect chain unbroken.

**Rule:** ALL internal code must use Effect.ts. Only user-facing API boundaries (JSX components, React GUI) are exempt. The `<Sandbox>` JSX component is exempt, but everything beneath it is Effect.

**This is the most architecturally significant ticket.** The sandbox lifecycle must be modeled as an `@effect/workflow` Workflow with Activities for each phase. Each transport is an Effect `Layer`. The Codeplane transport uses `@effect/cluster` entities.

### Packages

- **`@effect/workflow`** — `Workflow.make()` for the sandbox lifecycle, `Activity.make()` for each phase, `DurableDeferred` for diff review gates, `DurableClock.sleep()` for idle timeout
- **`@effect/cluster`** — `Entity.make()` for Codeplane remote workspace management, `Sharding` for distributing sandbox entities
- **`effect`** core — `Effect.gen`, `Layer`, `Context`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Schema`

### Sandbox lifecycle as a Workflow

The full lifecycle (create, pack, ship, execute, heartbeat, collect, review, accept) is a durable workflow with Activities:

```typescript
import { Workflow, Activity, DurableDeferred, DurableClock } from "@effect/workflow"
import { Effect, Schema, Layer, Context } from "effect"

// The sandbox workflow
const SandboxWorkflow = Workflow.make({
  name: "SandboxExecution",
  payload: Schema.Struct({
    runId: Schema.String,
    sandboxId: Schema.String,
    runtime: Schema.Literal("bubblewrap", "docker", "codeplane"),
    config: Schema.Unknown,
  }),
  idempotencyKey: ({ runId, sandboxId }) => `${runId}:${sandboxId}`,
  success: SandboxResult,
  error: SandboxError,
})
```

### Each phase as an Activity

```typescript
// Phase 1: Create sandbox environment
const CreateSandbox = Activity.make({
  name: "sandbox:create",
  success: Schema.Struct({ containerId: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String) }),
  error: SandboxError,
  execute: Effect.gen(function*() {
    const transport = yield* SandboxTransport
    yield* Effect.annotateLogs({ sandboxId, runtime })
    yield* Effect.withLogSpan("sandbox:create")(
      transport.create(config)
    )
  })
})

// Phase 2: Pack bundle
const PackBundle = Activity.make({
  name: "sandbox:pack",
  success: Schema.Struct({ bundlePath: Schema.String, bundleSizeBytes: Schema.Number }),
  error: SandboxError,
  execute: Effect.gen(function*() {
    yield* Effect.withLogSpan("sandbox:pack")(
      serializeSubtree(workflowFragment, inputs, context)
    )
  })
})

// Phase 3: Ship bundle to sandbox
const ShipBundle = Activity.make({
  name: "sandbox:ship",
  success: Schema.Void,
  error: SandboxError,
  execute: Effect.gen(function*() {
    const transport = yield* SandboxTransport
    yield* Effect.withLogSpan("sandbox:ship")(
      transport.ship(bundlePath, containerId)
    )
  })
})

// Phase 4: Execute workflow inside sandbox
const ExecuteInSandbox = Activity.make({
  name: "sandbox:execute",
  success: Schema.Struct({ exitCode: Schema.Number }),
  error: SandboxError,
  execute: Effect.gen(function*() {
    const transport = yield* SandboxTransport
    yield* Effect.withLogSpan("sandbox:execute")(
      transport.execute("smithers up bundle.tsx")
    )
  })
})

// Phase 5: Validate bundle
const ValidateBundle = Activity.make({
  name: "sandbox:validate",
  success: BundleManifest,
  error: Schema.Union(SandboxError, ValidationError),
  execute: Effect.gen(function*() {
    yield* Effect.withLogSpan("sandbox:receive")(
      validateBundleManifest(bundlePath)
    )
  })
})

// Phase 6: Collect results from sandbox
const CollectBundle = Activity.make({
  name: "sandbox:collect",
  success: Schema.Struct({ bundlePath: Schema.String, patchCount: Schema.Number }),
  error: SandboxError,
  execute: Effect.gen(function*() {
    const transport = yield* SandboxTransport
    yield* Effect.withLogSpan("sandbox:receive")(
      transport.collect(containerId)
    )
  })
})
```

### Diff review gate via DurableDeferred

```typescript
// Phase 7: Review gate for diffs (if reviewDiffs=true)
const reviewDiffs = (sandboxId: string, patches: Patch[]) =>
  Effect.gen(function*() {
    const deferred = DurableDeferred.make(`sandbox-review:${sandboxId}`, {
      success: Schema.Struct({
        approved: Schema.Boolean,
        note: Schema.optional(Schema.String),
      })
    })

    // Publish the review token so the approval system can signal back
    const token = yield* DurableDeferred.token(deferred)
    yield* publishReviewRequest({ sandboxId, token, patches })

    yield* Effect.withLogSpan("sandbox:review")(
      Effect.logInfo("Waiting for diff review approval")
    )

    // Block until operator approves or denies
    const decision = yield* DurableDeferred.await(deferred)

    if (!decision.approved) {
      return yield* Effect.fail(new SandboxDiffRejected({ sandboxId, reason: decision.note }))
    }

    // Phase 8: Apply diffs
    yield* Effect.withLogSpan("sandbox:apply")(
      applyPatches(patches)
    )
  })
```

### SandboxTransport as an Effect Layer/Service

```typescript
// Service interface for sandbox transports
class SandboxTransport extends Context.Tag("SandboxTransport")<
  SandboxTransport,
  {
    readonly create: (config: SandboxConfig) => Effect.Effect<SandboxHandle, SandboxError>
    readonly ship: (bundlePath: string, handle: SandboxHandle) => Effect.Effect<void, SandboxError>
    readonly execute: (command: string) => Effect.Effect<{ exitCode: number }, SandboxError>
    readonly collect: (handle: SandboxHandle) => Effect.Effect<BundleResult, SandboxError>
    readonly cleanup: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>
  }
>() {}

// Bubblewrap transport Layer
const BubblewrapTransport: Layer.Layer<SandboxTransport> = Layer.succeed(
  SandboxTransport,
  SandboxTransport.of({
    create: (config) => Effect.gen(function*() {
      // bwrap namespace setup (pid, net, mount, ipc)
      // macOS fallback to sandbox-exec
    }),
    ship: (bundlePath, handle) => Effect.gen(function*() {
      // bind-mount bundle into namespace
    }),
    execute: (command) => Effect.gen(function*() {
      // bwrap --unshare-all ... smithers up bundle.tsx
      yield* spawnCaptureEffect(["bwrap", ...namespaceArgs, command])
    }),
    collect: (handle) => Effect.gen(function*() {
      // read from writable workspace dir
    }),
    cleanup: (handle) => Effect.void,
  })
)

// Docker transport Layer
const DockerTransport: Layer.Layer<SandboxTransport> = Layer.succeed(
  SandboxTransport,
  SandboxTransport.of({
    create: (config) => Effect.gen(function*() {
      // docker create with resource limits
    }),
    ship: (bundlePath, handle) => Effect.gen(function*() {
      // docker cp bundle into container
    }),
    execute: (command) => Effect.gen(function*() {
      // docker exec smithers up bundle.tsx
    }),
    collect: (handle) => Effect.gen(function*() {
      // docker cp results out
    }),
    cleanup: (handle) => Effect.gen(function*() {
      // docker rm
    }),
  })
)

// Codeplane transport Layer (uses @effect/cluster entities)
const CodeplaneTransport: Layer.Layer<SandboxTransport> = Layer.effect(
  SandboxTransport,
  Effect.gen(function*() {
    const sharding = yield* Sharding
    // ... build transport using cluster entities for remote workspace management
  })
)
```

### Codeplane transport with @effect/cluster entities

```typescript
import { Entity, Sharding, Rpc } from "@effect/cluster"
import { Schema } from "effect"

// RPC messages for workspace management
const CreateWorkspace = Rpc.make("CreateWorkspace", {
  payload: Schema.Struct({ name: Schema.String, snapshotId: Schema.optional(Schema.String) }),
  success: Schema.Struct({ workspaceId: Schema.String, sshInfo: SshInfo }),
})

const ExecuteInWorkspace = Rpc.make("ExecuteInWorkspace", {
  payload: Schema.Struct({ workspaceId: Schema.String, command: Schema.String }),
  success: Schema.Struct({ exitCode: Schema.Number }),
})

// Workspace entity
const WorkspaceEntity = Entity.make("Workspace", [
  CreateWorkspace,
  ExecuteInWorkspace,
])
```

### Full workflow orchestration

```typescript
// The complete sandbox workflow execution
const sandboxExecution = Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId, sandboxId, runtime })

  const handle = yield* CreateSandbox
  const bundle = yield* PackBundle
  yield* ShipBundle
  yield* ExecuteInSandbox

  const result = yield* CollectBundle
  const manifest = yield* ValidateBundle

  // Diff review gate (if enabled)
  if (reviewDiffs && manifest.patches.length > 0) {
    yield* reviewDiffs(sandboxId, manifest.patches)
  }

  // Cleanup
  yield* Effect.withLogSpan("sandbox:cleanup")(
    (yield* SandboxTransport).cleanup(handle)
  )

  return result
})
```

### Effect patterns to apply

- Model the entire sandbox lifecycle as a `Workflow.make()` so it survives process restarts
- Each phase (create, pack, ship, execute, collect, validate) is an `Activity.make()` so it is independently retriable
- Transport backends are Effect `Layer`s implementing a `SandboxTransport` service interface via `Context.Tag`
- Diff review gates use `DurableDeferred` for operator approval (same mechanism as workflow signals)
- Bundle validation is an Activity so invalid bundles trigger retry, not permanent failure
- Codeplane transport uses `@effect/cluster` `Entity.make()` for remote workspace management
- Heartbeat monitoring during execution integrates with `Activity` heartbeat (see task-heartbeats ticket)

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for sandbox workflow execution
- `src/effect/metrics.ts` — Wire sandbox metrics (`smithers.sandbox.created_total`, `smithers.sandbox.duration_ms`, etc.) using existing histogram/counter helpers
- `src/effect/child-process.ts` — `spawnCaptureEffect()` for bubblewrap/docker process spawning
- `src/effect/logging.ts` — Annotate sandbox spans with `{ runId, sandboxId, runtime, containerId?, workspaceId? }`
- `src/effect/interop.ts` — Use `fromPromise()` for bridging Codeplane SDK calls into Effect

### Reference files

- `/Users/williamcory/effect-reference/packages/workflow/src/Workflow.ts` — Workflow definition for the sandbox lifecycle
- `/Users/williamcory/effect-reference/packages/workflow/src/Activity.ts` — Activity definition for each sandbox phase
- `/Users/williamcory/effect-reference/packages/workflow/src/DurableDeferred.ts` — DurableDeferred for diff review gates
- `/Users/williamcory/effect-reference/packages/workflow/src/DurableClock.ts` — Durable timers for idle timeout
- `/Users/williamcory/effect-reference/packages/cluster/src/Entity.ts` — Entity definition for Codeplane workspace actors
- `/Users/williamcory/effect-reference/packages/cluster/src/Sharding.ts` — Sharding for distributing workspace entities
- `/Users/williamcory/effect-reference/packages/cluster/src/ClusterWorkflowEngine.ts` — Cluster+Workflow integration for durable distributed sandbox execution
- `/Users/williamcory/effect-reference/packages/cluster/test/Entity.test.ts` — Entity usage examples for workspace management patterns
- `/Users/williamcory/effect-reference/packages/workflow/test/WorkflowEngine.test.ts` — Workflow test patterns for lifecycle orchestration
