# Cloud Execution — Engineering Spec

> Internal engineering document. Implementation details for distributed Smithers.

## Overview

This document covers the technical implementation of distributed Smithers
execution across Kubernetes and Plue's self-hosted Microsandbox plane. The product spec
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
  name: smthrs
  namespace: smithers-system
spec:
  selector:
    app: smthrs
  ports:
    - name: gateway
      port: 3000
    - name: cluster
      port: 3001
```

Workers set `SMITHERS_ORCHESTRATOR_URL=http://smthrs:3001`.

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

await $`docker build --target orchestrator -t smthrs:${tag} .`;
await $`docker build --target worker -t smithers-worker:${tag} .`;

console.log(`Built smthrs:${tag} and smithers-worker:${tag}`);
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
  name: smthrs
  namespace: smithers-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: smthrs
  template:
    metadata:
      labels:
        app: smthrs
    spec:
      containers:
        - name: orchestrator
          image: smthrs:latest
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
  name: smthrs
  namespace: smithers-system
spec:
  selector:
    app: smthrs
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
              value: http://smthrs.smithers-system.svc.cluster.local:3001
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
    app: smthrs
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

## Part 5: Sandbox Provider Implementations

### Plue and Microsandbox production boundary

Smithers ships a first-class local `microsandbox` provider. Plue's production
provider uses the same request/result semantics through a remote Plue-owned
control plane rather than running KVM in the Smithers or Plue API process.

- Plue keeps its GKE Autopilot control plane and adds a separate private GKE
  Standard cluster with nested-virtualization workers.
- Product services use Plue-owned DTOs; Microsandbox SDK types do not cross the
  API boundary.
- A controller places microVMs, persists worker/generation/desired state, and
  fences stale operations. Application gateways stream terminal, SSH, and
  preview traffic to the owning worker with short-lived grants.
- Microsandbox `0.6.6` snapshots are disk-only, require a stopped sandbox, and
  cold-boot on restore. Memory, processes, sockets, and devices are not durable.
- Secrets use a nonpersisting operation-scoped path. The raw Go `Secret.Env`
  representation is not acceptable because it persists the value; credential
  proxy capabilities are used for richer policy and audit.

The local adapter is documented in
`docs/integrations/microsandbox-sandbox-provider.mdx`. Fleet placement,
recovery, Terraform, gateways, and production conformance belong to Plue and
are deliberately outside Smithers core.

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
      await $`minikube image load smthrs:latest`;
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
      await $`kubectl wait --for=condition=ready pod -l app=smthrs -n smithers-system --timeout=120s`;

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

### Phase D: Microsandbox Integration

1. Use the first-class Microsandbox `SandboxProvider` locally and preserve the
   same contract in Plue's remote adapter.
2. Pin runtime and image versions and verify every worker with a real microVM.
3. Implement image and stopped-disk snapshot creation in the hosted provider
   layer.
4. Implement stop/cold-resume at task boundaries without claiming memory
   preservation.
5. Implement disk snapshots at supported frames.
6. Implement fork as DB fork plus independent disk snapshot and cold boot.
7. Test end to end on real nested KVM: image, run, stop/resume, snapshot, fork,
   access stream, secret sentinel, and cleanup.

### Phase E: Plue Integration

1. Update hosted workflows to use provider-neutral Plue sandboxes.
2. Integrate with Plue branch management (rebase, stacked PRs).
3. Repository-scoped versioned images and disk snapshots.
4. Test via the Plue CLI and Multi against the production Microsandbox plane.

---

## Appendix A: Reference — Fabrik (Samuel Huber)

[Fabrik](https://github.com/SamuelLHuber/local-isolated-ralph) by
[Samuel Huber](https://github.com/SamuelLHuber) (dTech.vision) is an existing
K3s-based Kubernetes layer for Smithers. It has `smthrs` as a
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
