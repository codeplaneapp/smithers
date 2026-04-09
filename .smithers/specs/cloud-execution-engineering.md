# Cloud Execution — Engineering Spec

> Internal engineering document. Implementation details for distributed Smithers.

## Overview

This document covers the technical implementation of distributed Smithers
execution across Kubernetes and Freestyle/JJHub. The product spec
(`cloud-execution-product.md`) covers the what and why; this covers the how.

---

## Part 1: Storage Abstraction Layer

### Design Principle

The storage layer abstracts at the lowest possible level. The entire codebase
above the adapter uses a single `SmithersStorage` interface. The adapter is
responsible for translating between dialects. **No dialect-specific code exists
outside the adapter layer.**

### Interface

```ts
// src/storage/interface.ts
import { Context, Effect } from "effect";

export class SmithersStorage extends Context.Tag("SmithersStorage")<
  SmithersStorage,
  {
    // Internal tables (events, runs, nodes, attempts, approvals, signals, etc.)
    readonly sql: SqlClient;  // @effect/sql SqlClient — dialect-agnostic

    // User output tables (Zod → Drizzle)
    readonly drizzle: DrizzleInstance;  // dialect-aware Drizzle instance

    // Transaction support
    readonly withTransaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}
```

### SQLite Adapter (local dev, default)

```ts
// src/storage/sqlite.ts
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { drizzle } from "drizzle-orm/bun-sqlite";

export const SqliteStorageLayer = (dbPath: string) =>
  Layer.effect(SmithersStorage, Effect.gen(function* () {
    const sqlClient = yield* SqliteClient.make({ filename: dbPath });
    const bunDb = new Database(dbPath);
    const drizzleDb = drizzle(bunDb);

    return SmithersStorage.of({
      sql: sqlClient,
      drizzle: drizzleDb,
      withTransaction: (effect) =>
        sqlClient.withTransaction(effect),
    });
  }));
```

### Postgres Adapter (Kubernetes)

```ts
// src/storage/postgres.ts
import { PgClient } from "@effect/sql-pg";
import { drizzle } from "drizzle-orm/node-postgres";

export const PostgresStorageLayer = (config: PgConfig) =>
  Layer.effect(SmithersStorage, Effect.gen(function* () {
    const sqlClient = yield* PgClient.make({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      password: config.password,
    });
    const drizzleDb = drizzle(config.connectionString);

    return SmithersStorage.of({
      sql: sqlClient,
      drizzle: drizzleDb,
      withTransaction: (effect) =>
        sqlClient.withTransaction(effect),
    });
  }));
```

### Migration Strategy

1. Create `src/storage/` directory with `interface.ts`, `sqlite.ts`, `postgres.ts`
2. Update `src/db/adapter.ts` to consume `SmithersStorage` instead of direct
   SQLite access
3. `SqlMessageStorage` (from `@effect/cluster`) already uses `SqlClient` — it
   works with both backends automatically
4. User output tables need Drizzle dialect awareness:
   - `src/db/output.ts` currently uses `drizzle-orm/bun-sqlite` types
   - Abstract to dialect-agnostic Drizzle (column types differ between SQLite
     and Postgres: `integer` vs `serial`, `text` vs `varchar`, etc.)
   - Create a schema builder that emits dialect-appropriate column definitions

### SQL Dialect Differences to Handle

| Feature | SQLite | Postgres |
|---|---|---|
| Auto-increment PK | `INTEGER PRIMARY KEY` | `SERIAL PRIMARY KEY` |
| Boolean | `INTEGER (0/1)` | `BOOLEAN` |
| JSON | `TEXT` (parsed in app) | `JSONB` (native) |
| Timestamps | `INTEGER` (ms epoch) | `TIMESTAMPTZ` or `BIGINT` |
| Transactions | `BEGIN IMMEDIATE` | `BEGIN` |
| Upsert | `INSERT OR REPLACE` | `INSERT ... ON CONFLICT` |
| Full-text search | FTS5 | `tsvector` |

The adapter handles these transparently. Application code never writes raw SQL
with dialect-specific syntax.

---

## Part 2: Orchestrator / Worker Split

### Process Modes

A single Smithers binary supports three modes via `SMITHERS_ROLE`:

```ts
type SmithersRole = "standalone" | "orchestrator" | "worker";
```

- **standalone** (default, current behavior): Everything in one process
- **orchestrator**: React renderer, scheduler, sharding manager, Gateway, cron.
  Does NOT execute tasks locally.
- **worker**: `HttpRunner.layerServer`, receives and executes tasks. Does NOT
  render JSX or schedule.

### Orchestrator Implementation

```ts
// src/roles/orchestrator.ts
const OrchestratorLayer = Layer.mergeAll(
  // Scheduler + React renderer
  SmithersSchedulerLayer,
  // Cluster sharding manager
  Sharding.layer,
  // Storage (Postgres in K8s)
  PostgresStorageLayer(pgConfig),
  // Gateway server
  GatewayLayer({ port: 3000 }),
  // Cluster RPC server (for worker registration)
  HttpRunner.layerManagerServer({ port: 3001 }),
  // Message persistence
  SqlMessageStorage.layer,
);
```

The orchestrator dispatches tasks via `@effect/cluster` sharding:

```ts
// In the scheduler loop, replace inline execution:
// OLD: const result = await executeTask(adapter, db, runId, desc);
// NEW:
const taskClient = yield* TaskWorkerEntity.client;
const workerId = yield* Sharding.getShardId(workerTask.executionId);
const result = yield* taskClient(workerId).execute(workerTask);
```

### Worker Implementation

```ts
// src/roles/worker.ts
const WorkerLayer = Layer.mergeAll(
  // HTTP server that receives tasks from orchestrator
  HttpRunner.layerServer({ port: 3002 }),
  // Task execution entity
  TaskWorkerEntity.toLayer(
    Effect.gen(function* () {
      return TaskWorkerEntity.of({
        execute: ({ payload }) => executeWorkerTask(payload),
      });
    }),
  ),
  // Agent registry (resolves agentId → agent implementation)
  AgentRegistryLayer,
  // Tool registry (resolves tool names → tool implementations)
  ToolRegistryLayer,
);
```

Workers need:
- All agent implementations (`src/agents/`)
- All tool implementations (`src/tools/`)
- The workflow code (for `computeFn` tasks that reference user functions)
- Environment variables for API keys

Workers do NOT need:
- React renderer
- Scheduler
- Database access (orchestrator persists results)
- Gateway

### Communication Protocol

```
Orchestrator                           Worker
     │                                    │
     │─── POST /rpc (WorkerTask) ────────►│
     │                                    │ resolve agent from agentId
     │                                    │ resolve tools from tool names
     │                                    │ execute task
     │◄─── SSE heartbeat(checkpoint) ─────│ (every 10s)
     │                                    │
     │◄─── POST /rpc (TaskResult) ────────│
     │     { outputJson, diffBundle,      │
     │       errorJson, durationMs }      │
     │                                    │
     │── persist to SqlMessageStorage ──► │
     │── apply DiffBundle to working tree │
```

Transport: `@effect/rpc` over HTTP (`HttpRunner`). Heartbeats stream via SSE.
DiffBundles stream as chunked responses for large payloads.

### Worker Registration and Discovery

Workers register with the orchestrator's sharding manager on startup:

```ts
// Worker startup
const runner = yield* HttpRunner.makeClient({
  managerUrl: process.env.SMITHERS_ORCHESTRATOR_URL,
  runnerId: process.env.HOSTNAME,  // K8s pod name
});
yield* runner.register();
```

In Kubernetes, worker pods discover the orchestrator via a Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: smithers-orchestrator
  namespace: smithers-system
spec:
  selector:
    app: smithers-orchestrator
  ports:
    - name: gateway
      port: 3000
    - name: cluster
      port: 3001
```

Workers set `SMITHERS_ORCHESTRATOR_URL=http://smithers-orchestrator:3001`.

### Task Serialization

The existing `WorkerTask` schema (`src/effect/entity-worker.ts`) is already
serializable. Extend it with fields needed for remote execution:

```ts
export const WorkerTask = Schema.Struct({
  // Existing fields
  executionId: Schema.String,
  bridgeKey: Schema.String,
  workflowName: Schema.String,
  runId: Schema.String,
  nodeId: Schema.String,
  iteration: Schema.Number,
  retries: Schema.Number,
  taskKind: WorkerTaskKind,
  dispatchKind: WorkerDispatchKind,

  // New fields for remote execution
  prompt: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  agentConfig: Schema.Unknown,  // serialized AgentConfig
  tools: Schema.Array(Schema.String),  // tool names
  rootDir: Schema.String,
  allowNetwork: Schema.Boolean,
  toolTimeoutMs: Schema.Number,
  maxOutputBytes: Schema.Number,
  previousHeartbeat: Schema.NullOr(Schema.Unknown),
  idempotencyKey: Schema.String,
  envVars: Schema.Record({ key: Schema.String, value: Schema.String }),
});
```

### Crash Recovery

**Worker crash:** Orchestrator detects missing heartbeat (>60s stale) → shard
reassigned to healthy worker → task re-dispatched with same idempotency key →
Activity layer returns cached result if already completed, re-executes otherwise.

**Orchestrator crash:** Gateway becomes unreachable. On restart:
1. Load state from Postgres (SqlMessageStorage)
2. Re-render JSX tree from persisted outputs
3. Detect orphaned in-progress tasks (heartbeat stale)
4. Re-dispatch orphaned tasks to workers
5. Resume workflow from last consistent state

**Both crash:** Same as orchestrator crash — Postgres is the source of truth.
Workers are stateless; new workers pick up where old ones left off.

---

## Part 3: Docker Image Build

### Dockerfile

```dockerfile
# examples/kubernetes/Dockerfile
FROM oven/bun:1.3 AS base

# Install system dependencies for agents
RUN apt-get update && apt-get install -y git jj curl && rm -rf /var/lib/apt/lists/*

# Install workflow dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy workflow code
COPY . .

# Orchestrator entrypoint
FROM base AS orchestrator
ENV SMITHERS_ROLE=orchestrator
EXPOSE 3000 3001
CMD ["bun", "run", "smithers", "serve", "--gateway"]

# Worker entrypoint
FROM base AS worker
ENV SMITHERS_ROLE=worker
EXPOSE 3002
CMD ["bun", "run", "smithers", "worker"]
```

### Build Script

```ts
// examples/kubernetes/scripts/build.ts
import { $ } from "bun";

const tag = process.env.IMAGE_TAG ?? "latest";

await $`docker build --target orchestrator -t smithers-orchestrator:${tag} .`;
await $`docker build --target worker -t smithers-worker:${tag} .`;

console.log(`Built smithers-orchestrator:${tag} and smithers-worker:${tag}`);
```

### Alternative: Init Container (no custom image)

For development workflows where rebuilding images is too slow:

```yaml
# k8s/worker-with-init.yaml
spec:
  initContainers:
    - name: setup
      image: oven/bun:1.3
      command: ["sh", "-c"]
      args:
        - |
          git clone $REPO_URL /workspace
          cd /workspace
          bun install
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  containers:
    - name: worker
      image: oven/bun:1.3
      command: ["bun", "run", "smithers", "worker"]
      workingDir: /workspace
      volumeMounts:
        - name: workspace
          mountPath: /workspace
```

---

## Part 4: Kubernetes Manifests

### Namespace

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: smithers-system
```

### PostgreSQL

```yaml
# k8s/postgres.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: smithers-postgres
  namespace: smithers-system
spec:
  serviceName: smithers-postgres
  replicas: 1
  selector:
    matchLabels:
      app: smithers-postgres
  template:
    metadata:
      labels:
        app: smithers-postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: smithers
            - name: POSTGRES_USER
              value: smithers
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: smithers-secrets
                  key: pg-password
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: pgdata
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: smithers-postgres
  namespace: smithers-system
spec:
  selector:
    app: smithers-postgres
  ports:
    - port: 5432
```

### Orchestrator

```yaml
# k8s/orchestrator.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: smithers-orchestrator
  namespace: smithers-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: smithers-orchestrator
  template:
    metadata:
      labels:
        app: smithers-orchestrator
    spec:
      containers:
        - name: orchestrator
          image: smithers-orchestrator:latest
          ports:
            - name: gateway
              containerPort: 3000
            - name: cluster
              containerPort: 3001
          env:
            - name: SMITHERS_ROLE
              value: orchestrator
            - name: SMITHERS_PG_HOST
              value: smithers-postgres.smithers-system.svc.cluster.local
            - name: SMITHERS_PG_PORT
              value: "5432"
            - name: SMITHERS_PG_DATABASE
              value: smithers
            - name: SMITHERS_PG_USER
              value: smithers
            - name: SMITHERS_PG_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: smithers-secrets
                  key: pg-password
          envFrom:
            - secretRef:
                name: smithers-api-keys
          resources:
            requests:
              cpu: "500m"
              memory: 1Gi
            limits:
              cpu: "2"
              memory: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: smithers-orchestrator
  namespace: smithers-system
spec:
  selector:
    app: smithers-orchestrator
  ports:
    - name: gateway
      port: 3000
    - name: cluster
      port: 3001
```

### Workers

```yaml
# k8s/worker.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: smithers-worker
  namespace: smithers-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: smithers-worker
  template:
    metadata:
      labels:
        app: smithers-worker
    spec:
      containers:
        - name: worker
          image: smithers-worker:latest
          ports:
            - name: rpc
              containerPort: 3002
          env:
            - name: SMITHERS_ROLE
              value: worker
            - name: SMITHERS_ORCHESTRATOR_URL
              value: http://smithers-orchestrator.smithers-system.svc.cluster.local:3001
          envFrom:
            - secretRef:
                name: smithers-api-keys
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "4"
              memory: 8Gi
---
apiVersion: v1
kind: Service
metadata:
  name: smithers-worker
  namespace: smithers-system
spec:
  selector:
    app: smithers-worker
  ports:
    - port: 3002
```

### Gateway (external access)

```yaml
# k8s/gateway.yaml
apiVersion: v1
kind: Service
metadata:
  name: smithers-gateway
  namespace: smithers-system
spec:
  type: LoadBalancer
  selector:
    app: smithers-orchestrator
  ports:
    - name: http
      port: 80
      targetPort: 3000
    - name: ws
      port: 443
      targetPort: 3000
```

### Secrets (template)

```yaml
# k8s/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: smithers-secrets
  namespace: smithers-system
type: Opaque
stringData:
  pg-password: "CHANGE_ME"
---
apiVersion: v1
kind: Secret
metadata:
  name: smithers-api-keys
  namespace: smithers-system
type: Opaque
stringData:
  ANTHROPIC_API_KEY: ""
  OPENAI_API_KEY: ""
```

---

## Part 5: Freestyle Implementation

### New Sandbox Runtime

Add `"freestyle"` to `SandboxRuntime`:

```ts
// src/sandbox/transport.ts
export type SandboxRuntime = "bubblewrap" | "docker" | "codeplane" | "freestyle";
```

### Freestyle Executor

```ts
// src/effect/freestyle-runner.ts
import { Effect, Layer } from "effect";
import { SandboxEntityExecutor } from "./sandbox-entity";

export const FreestyleSandboxExecutorLive = Layer.effect(
  SandboxEntityExecutor,
  Effect.gen(function* () {
    const apiKey = process.env.FREESTYLE_API_KEY;
    const apiUrl = process.env.FREESTYLE_API_URL ?? "https://api.freestyle.sh";

    if (!apiKey) {
      yield* Effect.fail(
        new SmithersError(
          "INVALID_INPUT",
          "Freestyle runtime requires FREESTYLE_API_KEY.",
        ),
      );
    }

    // HTTP client for Freestyle API
    const freestyleClient = makeFreestyleClient({ apiKey, apiUrl });

    return SandboxEntityExecutor.of({
      create: (config) =>
        Effect.gen(function* () {
          const handle = baseHandle(config);
          const snapshotId = config.workspace?.snapshotId;

          // Fork from snapshot (fast path) or create fresh
          const vm = snapshotId
            ? yield* fromPromise("fork freestyle VM", () =>
                freestyleClient.fork(snapshotId))
            : yield* fromPromise("create freestyle VM", () =>
                freestyleClient.create(defaultVmSpec));

          return {
            ...handle,
            workspaceId: vm.id,
          };
        }),

      ship: (bundlePath, handle) =>
        fromPromise("upload bundle to freestyle VM", () =>
          freestyleClient.upload(handle.workspaceId!, bundlePath, "/tmp/bundle")),

      execute: (command, handle) =>
        fromPromise("exec in freestyle VM", async () => {
          const result = await freestyleClient.exec(handle.workspaceId!, command);
          return { exitCode: result.exitCode };
        }),

      collect: (handle) =>
        fromPromise("download result from freestyle VM", async () => {
          const localPath = join(handle.resultPath, "output");
          await freestyleClient.download(handle.workspaceId!, "/tmp/result", localPath);
          return { bundlePath: localPath };
        }),

      cleanup: (handle) =>
        fromPromise("cleanup freestyle VM", async () => {
          const persistence = config.workspace?.persistence ?? "ephemeral";
          if (persistence === "sticky") {
            await freestyleClient.pause(handle.workspaceId!);
          } else {
            await freestyleClient.destroy(handle.workspaceId!);
          }
        }),
    });
  }),
);
```

### Golden Image Creation

```ts
// src/freestyle/golden-image.ts

export async function createGoldenImage(opts: {
  workflowDir: string;
  freestyleClient: FreestyleClient;
  vmSpec?: Partial<VmSpec>;
}): Promise<{ snapshotId: string }> {
  // 1. Create base VM
  const vm = await opts.freestyleClient.create({
    os: "ubuntu-24.04",
    vcpus: opts.vmSpec?.vcpus ?? 4,
    memory: opts.vmSpec?.memory ?? "8GiB",
    disk: opts.vmSpec?.disk ?? "20GiB",
    aptDeps: ["git", "jj", "curl", "unzip"],
    ...opts.vmSpec,
  });

  // 2. Install Bun
  await opts.freestyleClient.exec(vm.id,
    "curl -fsSL https://bun.sh/install | bash");

  // 3. Upload workflow code
  await opts.freestyleClient.upload(vm.id,
    opts.workflowDir, "/opt/smithers");

  // 4. Install dependencies
  await opts.freestyleClient.exec(vm.id,
    "cd /opt/smithers && /root/.bun/bin/bun install --frozen-lockfile");

  // 5. Snapshot
  const snapshot = await opts.freestyleClient.snapshot(vm.id);

  // 6. Pause base VM (keep for updates)
  await opts.freestyleClient.pause(vm.id);

  return { snapshotId: snapshot.id };
}
```

### CLI Command

```bash
# Create golden image
smithers env:setup --freestyle

# Run workflow on Freestyle workers
smithers run workflow.tsx --runtime freestyle --snapshot-id snap_abc123

# Fork a run (DB fork + VM fork)
smithers fork workflow.tsx --run-id run-001 --frame 5 --runtime freestyle
```

### Pause/Resume at Task Boundaries

After each task completes, the worker VM can be paused:

```ts
// In freestyle worker lifecycle:
async function executeAndPause(task: WorkerTask, vm: FreestyleVm) {
  // Execute task
  const result = await executeTask(task);

  // If workflow has more tasks, pause VM (storage-only billing)
  if (!result.terminal) {
    await vm.pause();
    // VM resumes when next task is dispatched
  }

  return result;
}
```

For workflows with approval gates or timers, the VM stays paused for the
entire wait period — hours or days — at storage cost only (~$0.000086/GiB-hr).

### VM Snapshot at Frames

Extend snapshot metadata to include Freestyle VM state:

```ts
// In src/time-travel/snapshot.ts, extend:
type SnapshotMeta = {
  runId: string;
  frameNo: number;
  contentHash: string;
  vcsRevision?: string;
  freestyleSnapshotId?: string;  // VM state reference
  freestyleVmId?: string;        // Source VM for this snapshot
};
```

When `smithers fork` is called with a Freestyle-backed run:
1. Copy DB snapshot (existing behavior)
2. Fork the Freestyle VM from the snapshot's `freestyleSnapshotId`
3. New run executes on the forked VM — exact filesystem state from that frame

---

## Part 6: Deploy Script

```ts
// examples/kubernetes/scripts/deploy.ts
import { $ } from "bun";

const target = process.argv.find(a => a.startsWith("--target="))
  ?.split("=")[1] ?? "minikube";

async function deploy() {
  switch (target) {
    case "minikube": {
      // Check minikube is running
      const status = await $`minikube status`.text();
      if (!status.includes("Running")) {
        console.log("Starting minikube...");
        await $`minikube start --cpus=4 --memory=8192`;
      }

      // Build images
      await $`bun run scripts/build.ts`;

      // Load into minikube
      await $`minikube image load smithers-orchestrator:latest`;
      await $`minikube image load smithers-worker:latest`;

      // Apply manifests
      await $`kubectl apply -f k8s/namespace.yaml`;
      await $`kubectl apply -f k8s/secrets.yaml`;
      await $`kubectl apply -f k8s/postgres.yaml`;

      // Wait for postgres
      await $`kubectl wait --for=condition=ready pod -l app=smithers-postgres -n smithers-system --timeout=120s`;

      await $`kubectl apply -f k8s/orchestrator.yaml`;
      await $`kubectl apply -f k8s/worker.yaml`;
      await $`kubectl apply -f k8s/gateway.yaml`;

      // Wait for orchestrator
      await $`kubectl wait --for=condition=ready pod -l app=smithers-orchestrator -n smithers-system --timeout=120s`;

      const url = await $`minikube service smithers-gateway -n smithers-system --url`.text();
      console.log(`Gateway available at: ${url.trim()}`);
      break;
    }

    default:
      console.error(`Unknown target: ${target}`);
      process.exit(1);
  }
}

deploy();
```

---

## Part 7: Implementation Phases

### Phase A: Storage Abstraction (prerequisite for everything)

1. Create `src/storage/interface.ts` — `SmithersStorage` service tag
2. Create `src/storage/sqlite.ts` — SQLite adapter (wraps current behavior)
3. Create `src/storage/postgres.ts` — Postgres adapter
4. Refactor `src/db/adapter.ts` to consume `SmithersStorage`
5. Handle Drizzle dialect differences for user output tables
6. Test: all existing tests pass with SQLite adapter (no behavior change)
7. Test: core operations work against Postgres (new test suite)

### Phase B: Process Roles

1. Add `SMITHERS_ROLE` env var handling
2. Create `src/roles/orchestrator.ts` — orchestrator-only layer composition
3. Create `src/roles/worker.ts` — worker-only layer composition
4. Wire `HttpRunner.layerClient` in orchestrator for remote dispatch
5. Wire `HttpRunner.layerServer` in worker for task reception
6. Test: standalone mode unchanged; orchestrator + worker mode passes E2E

### Phase C: Kubernetes Example

1. Create `examples/kubernetes/` directory structure
2. Write Dockerfile (multi-stage: orchestrator + worker targets)
3. Write K8s manifests (namespace, postgres, orchestrator, worker, gateway, secrets)
4. Write bun scripts (build, deploy, teardown)
5. Write README (the product spec's README preview, fully fleshed out)
6. Test: deploy on Minikube, run a workflow end-to-end

### Phase D: Freestyle Integration

1. Add `"freestyle"` to `SandboxRuntime`
2. Implement `FreestyleSandboxExecutorLive`
3. Implement golden image creation (`smithers env:setup --freestyle`)
4. Implement pause/resume at task boundaries
5. Implement VM snapshot at frames
6. Implement fork = DB fork + VM fork
7. Test: E2E on Freestyle — create golden image, run workflow, fork

### Phase E: JJHub Integration

1. Update `.jjhub/workflows/` to support Freestyle-backed workers
2. Integrate with JJHub branch management (rebase, stacked PRs)
3. Repository-scoped golden images
4. Test: E2E via JJHub CLI

---

## Appendix A: Freestyle / JJHub Amendment

**Freestyle is encapsulated by JJHub.** The Freestyle API is not exposed
directly to users. JJHub is the user-facing platform that wraps Freestyle and
provides:

- VCS-aware workflow execution (jj branches, landing, stacked PRs)
- Repository-scoped golden images
- Workspace management
- Authentication and multi-tenancy

The `freestyle` sandbox runtime in Smithers is an implementation detail. Users
interact with JJHub, which provisions Freestyle VMs on their behalf.

JJHub may need updates to support the worker model described here. Specifically:
- Worker VM lifecycle management (fork, pause, resume, destroy)
- Golden image creation and management per repository
- Routing task dispatch to Freestyle-backed workers

> **Warning:** JJHub currently has a known bug where persistent VMs are not
> supported. This was resolved by upgrading our Freestyle plan tier. Ensure the
> JJHub deployment uses a Freestyle plan that supports persistent/sticky VMs
> before relying on pause/resume behavior.

---

## Appendix B: Reference — Fabrik (Samuel Huber)

[Fabrik](https://github.com/SamuelLHuber/local-isolated-ralph) by
[Samuel Huber](https://github.com/SamuelLHuber) (dTech.vision) is an existing
K3s-based Kubernetes layer for Smithers. It has `smithers-orchestrator` as a
direct dependency and takes a fundamentally different architecture.

### Fabrik Architecture

- **K3s** for production (single binary, CNCF-certified, low overhead)
- **K3d** (K3s-in-Docker) for local dev and CI
- **K8s is the sole source of truth** — no separate scheduler; CLI/TUI/Web all
  talk directly to the K8s API
- **Per-run PVCs** — each workflow run gets its own 10GB persistent volume for
  SQLite state (7-day retention after completion)
- **Kubernetes Jobs** — each workflow dispatch creates a K8s Job with init
  containers (git clone + state init) and a main Smithers container
- **CronJobs** for scheduled workflows
- **Two namespaces**: `fabrik-system` (control plane) and `fabrik-runs` (jobs)
- **Go CLI** (`fabrik`) for dispatching runs, rendering workflows, dry-runs
- **Terraform/OpenTofu + NixOS on Hetzner** for infrastructure provisioning
- **Helm charts** for deployment
- **Nix-built container images** (~50-100MB, multi-arch, non-root)
- **Immutable images** — Jobs must use image digests; resume uses exact same digest
- **Security hardening** — network policies (runs can't talk to control plane or
  each other), Pod Security Standards (restricted profile, non-root, read-only
  root fs), resource limits, audit logging

### Key Differences

| Aspect | Fabrik | Our Approach |
|---|---|---|
| K8s distribution | K3s (lightweight) | Standard K8s (any provider) |
| State storage | Per-run SQLite on PVC | Shared Postgres |
| Worker model | K8s Jobs per run | Long-lived worker Deployments |
| Task dispatch | K8s Job creation via API | @effect/cluster sharding via RPC |
| CLI | Go binary | Bun (same as Smithers) |
| Provisioning | Terraform + NixOS + Hetzner | Pure K8s manifests |
| Local dev | K3d (K3s-in-Docker) | Minikube |
| Image builds | Nix (reproducible, multi-arch) | Docker multi-stage |
| Status reporting | K8s pod annotations | @effect/rpc + Postgres |
| Observability | Prometheus/Loki/Grafana (LAOS) | OpenTelemetry + Prometheus |
| Security model | Network policies + PSS | Network policies (planned) |

### What We Can Learn From Fabrik

1. **Immutable image digests for resume** — good practice we should adopt.
   When resuming a workflow, use the exact same image digest to prevent
   code drift between execution and recovery.
2. **Security hardening** — network policies preventing runs from reaching
   the control plane or each other is smart. Their Pod Security Standards
   (restricted profile) is a good baseline.
3. **K3d parity testing** — their 8-check verification checklist for
   rootserver parity (spec 059) documents real problems: ImagePullBackOff
   on private registries, PVC storage class mismatches, DNS resolution
   failures in init containers, container runtime behavioral differences.
4. **Per-run isolation** — stronger security boundary than our shared-Postgres
   approach. Trade-off: harder to do cross-run queries and dashboards.

Fabrik is linked in the example README as an alternative for users who prefer
K3s, per-run isolation, or Hetzner/NixOS infrastructure.
