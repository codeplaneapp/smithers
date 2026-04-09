# Cloud Execution — Product Spec

> Internal product document. Not user-facing documentation.

## Problem

Smithers runs as a single Bun process today: orchestrator, workers, and SQLite
all share one machine. This limits us to vertical scaling and means a node
failure kills the entire workflow. Users need the ability to run production AI
workflows across multiple machines — scale workers independently, survive node
crashes, and manage expensive environment setup efficiently.

## Goals

1. **Distribute workers** across machines while keeping a single orchestrator as
   source of truth
2. **Kubernetes deployment** as the standard, provider-agnostic path
3. **JJHub / Freestyle deployment** as our platform path, with sub-200ms worker
   provisioning via VM forking
4. **Generalized architecture** — the orchestrator/worker split works everywhere,
   K8s and JJHub are just the first two targets
5. **Minimal API surface change** — users write the same JSX workflows; cloud
   deployment is a configuration concern

## Non-Goals

- Terraform or provider-specific infrastructure-as-code
- Multi-tenant orchestrator (one orchestrator per deployment for now)
- Rewriting the execution model (V2 engine redesign already handles this)

## Architecture Summary

```
Orchestrator (single process, source of truth)
├── React JSX → Plan Tree → Scheduler
├── @effect/cluster Sharding (routes tasks to workers)
├── SqlMessageStorage (Postgres in K8s, SQLite locally)
├── Gateway (WebSocket + HTTP for external clients)
└── Cron scheduler

Workers (N processes, stateless from orchestrator's perspective)
├── HttpRunner.layerServer (receives tasks via @effect/rpc)
├── TaskWorkerEntity (executes agent calls, compute functions)
├── DiffBundle computation (captures filesystem changes)
└── Heartbeat reporting → orchestrator
```

Workers are already serializable entities. `WorkerTask` contains only strings,
numbers, and IDs — no live closures. `TaskResult` returns JSON + DiffBundle.
The distributed architecture is already designed; this work activates it.

## Side Effect Contract

The current task contract captures two kinds of output:

1. **JSON output** — structured data validated against Zod schema
2. **DiffBundle** — filesystem changes recorded as unified diffs

Everything else is **not captured by the durable execution model**. This means:

- React `useState` / `useEffect` are not durable (state lives in memory, lost on
  crash). We may fix this by persisting React state to SQLite, but it's not in
  scope for this work.
- External API calls (Linear, GitHub, Slack) have no built-in idempotency
  guarantee from Smithers. Users must handle this themselves or use idempotency
  keys passed through the task context.
- Network side effects (HTTP requests, database writes) are not replayed on
  recovery — only the JSON output is.

This is a known limitation. Some of these should have first-class solutions
(durable React state); others are inherently user-land problems (external API
idempotency). We will document the contract clearly and revisit specific gaps as
separate work items.

## Data Storage Abstraction

**Critical design constraint:** The storage layer must abstract at the lowest
possible level so that the choice of Postgres vs SQLite does not leak through
the codebase.

```
┌────────────────────────────────────────┐
│          Application Code              │
│  (engine, scheduler, gateway, CLI)     │
└────────────────┬───────────────────────┘
                 │  SmithersStorage interface
┌────────────────▼───────────────────────┐
│        Storage Adapter Layer           │
│  Single interface, dialect-aware       │
├────────────────┬───────────────────────┤
│  SQLite        │  Postgres             │
│  (local, dev)  │  (K8s, production)    │
└────────────────┴───────────────────────┘
```

- Internal tables (`_smithers_*`) use `@effect/sql` with `SqlClient` — swap the
  client layer between `@effect/sql-sqlite-bun` and `@effect/sql-pg`
- User output tables (Zod → Drizzle) need a dialect-aware Drizzle adapter
- Turso (SQLite-over-network) is a future option but not in initial scope
- Postgres is the K8s default because `@effect/cluster` is tested against it

## Kubernetes Product Experience

### What the user does

1. `smithers build --docker` — produces an OCI image with workflow code + deps
2. Apply Kubernetes manifests (we provide them)
3. Workflows run distributed with zero code changes

### README-Driven Spec

The example project (`examples/kubernetes/`) walks users through deploying a
Smithers workflow on Kubernetes. The README is the product spec for the K8s
experience:

---

### `examples/kubernetes/README.md` — Preview

# Running Smithers on Kubernetes

Deploy Smithers workflows as a distributed system on any Kubernetes cluster.
The orchestrator runs as a single pod (source of truth), workers scale
independently as a Deployment.

## Prerequisites

- Docker (for building images)
- kubectl configured for your cluster
- A Kubernetes cluster (Minikube for local dev, or any cloud provider)

## Quick Start (Minikube)

```bash
# Start a local cluster
minikube start --cpus=4 --memory=8192

# Build the Smithers image
cd examples/kubernetes
bun run build

# Load image into Minikube
minikube image load smithers-example:latest

# Deploy
kubectl apply -f k8s/

# Watch it run
kubectl logs -f deployment/smithers-orchestrator

# Access the Gateway
minikube service smithers-gateway --url
```

## Project Structure

```
examples/kubernetes/
├── workflow.tsx           # Your Smithers workflow (same as local)
├── Dockerfile            # Multi-stage build: Bun + workflow + deps
├── package.json          # Dependencies
├── k8s/
│   ├── namespace.yaml    # smithers-system namespace
│   ├── postgres.yaml     # PostgreSQL StatefulSet
│   ├── orchestrator.yaml # Orchestrator Deployment (replicas: 1)
│   ├── worker.yaml       # Worker Deployment (replicas: 3, HPA-ready)
│   ├── gateway.yaml      # Gateway Service (LoadBalancer)
│   └── secrets.yaml      # API keys (template — fill in your own)
└── scripts/
    ├── build.ts          # bun run build — builds Docker image
    ├── deploy.ts         # bun run deploy — applies manifests
    └── teardown.ts       # bun run teardown — removes everything
```

## How It Works

**Orchestrator pod** — runs the React scheduler, builds plan trees, dispatches
tasks via `@effect/cluster` sharding. Connects to Postgres for state. Exposes
the Gateway API.

**Worker pods** — receive tasks via `@effect/rpc` over HTTP. Execute agents,
compute functions. Return JSON output + DiffBundle (filesystem changes as
patches). No direct database access.

**Postgres** — stores all workflow state: events, task results, approvals,
snapshots. Replaces SQLite for multi-process access.

Workers are stateless from the orchestrator's perspective. Kill a worker pod
and the orchestrator re-dispatches its tasks to another worker.

## Scaling Workers

```bash
# Manual scaling
kubectl scale deployment smithers-worker --replicas=10

# Or use HPA (included in worker.yaml)
# Scales on smithers_pending_tasks Prometheus metric
```

## Deploying to Cloud

The manifests work on any Kubernetes cluster. For quick testing:

```bash
# Deploy to the cheapest available option
bun run scripts/deploy.ts --target=minikube  # local
```

## Configuration

Environment variables in `k8s/secrets.yaml`:

| Variable | Required | Description |
|---|---|---|
| `SMITHERS_PG_HOST` | Yes | Postgres connection host |
| `SMITHERS_PG_PASSWORD` | Yes | Postgres password |
| `ANTHROPIC_API_KEY` | If using Claude | Claude API key |
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key |

## Writing Your Workflow

Your workflow code is identical to local Smithers:

```tsx
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers({
  analysis: z.object({ summary: z.string(), score: z.number() }),
});

export default smithers((ctx) => (
  <Workflow name="my-distributed-workflow">
    <Task id="analyze" agent={myAgent} output={outputs.analysis}>
      Analyze the repository
    </Task>
  </Workflow>
));
```

No code changes needed for Kubernetes deployment. The orchestrator/worker
split is handled by configuration.

## Alternative: Fabrik (K3s-based)

Samuel Huber built [Fabrik](https://github.com/SamuelLHuber/local-isolated-ralph),
a K3s-based Kubernetes layer for Smithers. Fabrik takes a different approach:

- Uses **K3s** (lightweight Kubernetes) instead of standard K8s
- **Go CLI** for dispatching runs as Kubernetes Jobs
- **Per-run PVCs** for SQLite state (each run gets its own persistent volume
  instead of shared Postgres)
- **NixOS + Hetzner** provisioning via Terraform/OpenTofu
- **K3d** for local development (K3s-in-Docker)

**When to use Fabrik instead:**
- You want each workflow run fully isolated with its own SQLite database
- You prefer K3s for lighter resource footprint
- You're deploying to Hetzner or want NixOS-based reproducible infrastructure
- You want a Go CLI for K8s-native job dispatch

**When to use this example instead:**
- You want standard Kubernetes that works on any provider
- You want shared Postgres for cross-run queries and observability
- You want the official Smithers worker model with `@effect/cluster` sharding
- You want HPA-based autoscaling

---

## Freestyle / JJHub Product Experience

### What the user does

1. Define workflow in `.jjhub/workflows/`
2. JJHub provisions Freestyle VMs from a golden snapshot
3. Workers fork from snapshot in <200ms — no cold start, no npm install
4. VMs pause between tasks (storage-only billing)

### Key differentiators from Kubernetes

| Capability | Kubernetes | JJHub (Freestyle) |
|---|---|---|
| Worker startup | 30-60s (image pull + init) | <200ms (VM fork) |
| Environment setup | Every pod or shared PVC | Once, then fork forever |
| State between tasks | External DB only | Full VM state preserved |
| Cost when idle | Full pod or scale-to-zero delay | Storage only |
| Fork/branch a run | New run from DB snapshot | DB snapshot + VM clone |

### Workflow

```
1. smithers env:setup --freestyle
   → Creates base VM, installs Bun + deps, snapshots golden image

2. Workflow runs:
   → Each task: fork golden VM (~200ms) → execute → pause ($0 CPU)
   → Human approval gate: VM paused for hours/days at storage cost only
   → Resume: instant warm start from paused state

3. smithers fork --run-id run-001 --frame 5
   → DB fork + VM fork → exact filesystem state from frame 5
```

### JJHub Integration

JJHub is the platform that wraps Freestyle and adds VCS-aware features:

- Branch management (create, rebase, stack PRs)
- Landing / merge queue integration
- Workflow-aware code review
- Repository-scoped golden images

The `.jjhub/workflows/` directory already contains workflows (`prepare-publish.tsx`,
`review-pr.tsx`, `verify-bug.tsx`) that will run on Freestyle-backed workers once
this integration is complete.

## Product Decisions

### Decided

1. **Postgres for K8s** — `@effect/cluster` is tested against it; proven at scale
2. **SQLite stays for local dev** — zero-config, single-file, current default
3. **Storage abstraction at lowest level** — single interface, dialect adapters,
   no leaking through codebase
4. **Docker images for K8s workers** — `smithers build --docker` produces OCI image
5. **Init containers supported** — alternative to baked images for dev workflows
6. **No Terraform** — pure Kubernetes manifests, provider-agnostic
7. **Bun scripts for deployment** — `bun run deploy` instead of shell scripts
8. **Reference Fabrik** — link to Samuel Huber's K3s approach as alternative

### Deferred

1. **Turso / LiteFS** — SQLite-over-network, future option after Postgres
2. **Multi-tenant orchestrator** — one orchestrator per deployment for now
3. **Durable React state** — `useState`/`useEffect` persistence to SQLite
4. **External API idempotency** — user-land responsibility for now
5. **HPA auto-configuration** — manual scaling first, then add metrics-based HPA
