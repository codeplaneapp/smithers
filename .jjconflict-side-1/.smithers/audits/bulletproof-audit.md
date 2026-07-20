## Executive summary

Smithers is functional and broad, but not yet bulletproof production-ready. Across 41 audited groups, the mean production-readiness score is 54.83. The strongest areas are DATABASE_PERSISTENCE, WORKFLOW_ENGINE, DEVELOPER_EXPERIENCE, HUMAN_IN_THE_LOOP, and JSX_RENDERING_SYSTEM, but even these still rely on incomplete no-mocks fault proof, uneven public contracts, and partial operational documentation.

The dominant pattern is that implementation and unit coverage exist, while production evidence is thin. Many features are usable for trusted local workflows, but the repo needs systematic crash/resume e2e tests, durable side-effect handling, runtime schema validation, security hardening, and scored evals before the advertised production surface matches the implementation.

## Cross-cutting themes

- evals is the weakest dimension at 21.22. Most groups have no scored eval coverage for agent-facing behavior, nondeterministic prompts, recovery guidance, or runtime regressions.
- e2e is the second weakest dimension at 35.98. The repo repeatedly lacks true no-mocks subprocess, CLI, Gateway, MCP, browser, Postgres, Electric, and crash/resume tests.
- jsdoc is the third weakest dimension at 41.95. Public API docs, generated declarations, and LLM bundles often drift from runtime behavior or omit important options and safety contracts.
- obs is weak at 47.32. Telemetry exists in pockets, but durable events, metrics catalogs, structured logs, spans, redaction checks, and correlation labels are inconsistent across feature boundaries.
- durability and security are both below production bar at 52.78 and 52.95. Side effects, async scorer jobs, tool calls, sandbox state, hot reload, worktrees, token stores, and Gateway streams need stronger persistence, idempotency, auth, and containment.
- types, arch, docs, and unit also average below 70. This shows the issue is systemic: even better-tested areas still need tighter contracts, modularization, generated schemas, and production guides.

## Scorecard

| Group | Overall | e2e | unit | obs | arch | jsdoc | docs | durability | types | security | evals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EXTERNAL_WORKFLOW_INTEGRATION | 32 | 18 | 52 | 6 | 42 | 36 | 24 | 34 | 41 | 19 | 13 |
| HOT_RELOAD | 32 | 5 | 58 | 30 | 30 | 45 | 40 | 28 | 45 | 36 | 0 |
| BUILTIN_WORKFLOW_PACKS | 36 | 18 | 34 | 39 | 41 | 25 | 45 | 32 | 44 | 28 | 33 |
| AI_ORCHESTRATION_COMPONENTS | 40 | 18 | 42 | 35 | 38 | 45 | 62 | 42 | 52 | 28 | 45 |
| DEVOPS_AUTOMATION_COMPONENTS | 42 | 12 | 48 | 20 | 43 | 38 | 68 | 34 | 56 | 32 | 8 |
| PLUGINS_AND_EXTENSIONS | 42 | 12 | 66 | 18 | 58 | 3 | 47 | 45 | 38 | 31 | 5 |
| WORKFLOW_PACK_COMPONENTS | 42 | 42 | 34 | 32 | 48 | 35 | 58 | 44 | 50 | 24 | 28 |
| MEMORY_SYSTEM | 45 | 18 | 65 | 42 | 54 | 20 | 63 | 50 | 48 | 54 | 35 |
| WORKFLOW_PACK_PROMPTS | 46 | 24 | 32 | 45 | 58 | 22 | 44 | 58 | 50 | 43 | 38 |
| BUILT_IN_TOOLS | 52 | 15 | 76 | 30 | 68 | 35 | 78 | 42 | 55 | 62 | 5 |
| HTTP_SERVE | 52 | 34 | 55 | 60 | 62 | 30 | 74 | 50 | 42 | 38 | 24 |
| USAGE_METERING | 52 | 15 | 68 | 5 | 72 | 78 | 62 | 42 | 61 | 60 | 0 |
| ELECTRIC_SYNC_PROXY | 53 | 45 | 63 | 58 | 67 | 42 | 50 | 35 | 48 | 68 | 0 |
| AGENT_INTEGRATIONS | 54 | 32 | 72 | 58 | 70 | 42 | 67 | 51 | 60 | 41 | 12 |
| CLI_SUBCOMMANDS | 54 | 47 | 58 | 32 | 55 | 42 | 66 | 45 | 35 | 49 | 12 |
| SCORERS_EVALUATION | 54 | 30 | 72 | 60 | 66 | 64 | 48 | 35 | 60 | 50 | 18 |
| MCP_SEMANTIC_SERVER | 55 | 18 | 62 | 25 | 64 | 35 | 84 | 55 | 60 | 56 | 18 |
| OPENAPI_INTEGRATION | 55 | 18 | 78 | 52 | 70 | 45 | 56 | 22 | 53 | 44 | 41 |
| SANDBOX_EXECUTION | 57 | 38 | 78 | 48 | 65 | 30 | 80 | 42 | 64 | 70 | 34 |
| EVENT_TYPES | 57 | 35 | 55 | 70 | 58 | 20 | 72 | 66 | 58 | 44 | 12 |
| CLI_COMMANDS | 58 | 52 | 64 | 39 | 57 | 43 | 78 | 66 | 46 | 62 | 36 |
| HTTP_SERVER | 58 | 42 | 68 | 72 | 58 | 55 | 70 | 63 | 52 | 65 | 5 |
| GATEWAY_PROTOCOL | 58 | 55 | 68 | 70 | 63 | 55 | 42 | 52 | 60 | 66 | 5 |
| OBSERVABILITY | 58 | 42 | 68 | 78 | 62 | 35 | 66 | 45 | 56 | 58 | 31 |
| ERROR_SYSTEM | 58 | 35 | 78 | 55 | 66 | 34 | 72 | 58 | 51 | 43 | 10 |
| VCS_INTEGRATION | 58 | 32 | 76 | 52 | 62 | 60 | 70 | 60 | 58 | 48 | 28 |
| CROSS_CUTTING_CONCERNS | 58 | 25 | 68 | 45 | 62 | 48 | 65 | 55 | 70 | 72 | 42 |
| WORKFLOW_PACK_AGENTS | 58 | 38 | 66 | 60 | 63 | 28 | 55 | 64 | 70 | 57 | 53 |
| ELECTRIC_CLIENT_SYNC | 59 | 38 | 78 | 43 | 72 | 70 | 48 | 64 | 61 | 66 | 5 |
| FLOW_CONTROL_COMPONENTS | 61 | 45 | 68 | 62 | 60 | 46 | 72 | 70 | 58 | 54 | 32 |
| TIME_TRAVEL_DEBUGGING | 61 | 42 | 78 | 70 | 64 | 55 | 62 | 68 | 61 | 58 | 5 |
| CLI_INFRASTRUCTURE | 62 | 61 | 74 | 63 | 58 | 48 | 73 | 72 | 50 | 66 | 34 |
| EFFECT_INTEGRATION | 62 | 58 | 78 | 66 | 61 | 43 | 60 | 50 | 49 | 57 | 20 |
| CONTROL_PLANE_AND_ACCOUNTS | 62 | 38 | 74 | 28 | 67 | 56 | 70 | 58 | 68 | 66 | 5 |
| SCHEMA_AND_DATA_UTILITIES | 62 | 45 | 78 | 22 | 70 | 42 | 50 | 67 | 45 | 72 | 10 |
| PACKAGE_AND_BUILD | 64 | 55 | 58 | 28 | 70 | 40 | 74 | 46 | 61 | 49 | 18 |
| JSX_RENDERING_SYSTEM | 66 | 45 | 82 | 42 | 75 | 50 | 80 | 68 | 63 | 55 | 46 |
| HUMAN_IN_THE_LOOP | 67 | 58 | 78 | 67 | 72 | 48 | 78 | 76 | 70 | 72 | 28 |
| WORKFLOW_ENGINE | 68 | 55 | 84 | 78 | 72 | 42 | 69 | 74 | 63 | 66 | 38 |
| DEVELOPER_EXPERIENCE | 68 | 62 | 82 | 72 | 75 | 45 | 66 | 60 | 64 | 74 | 18 |
| DATABASE_PERSISTENCE | 70 | 58 | 82 | 63 | 78 | 45 | 55 | 76 | 48 | 68 | 20 |

## Prioritized backlog

| Priority | Title | Group | Dimension | Severity | Rationale |
| --- | --- | --- | --- | --- | --- |
| 1 | Build a no-mocks fault e2e matrix | WORKFLOW_ENGINE | e2e | critical | The lowest practical confidence gap is process-level proof for crash, resume, approvals, timers, quota, CLI, Gateway, SQLite, and Postgres paths. |
| 2 | Make flagship semantics real or explicitly de-scope them | AI_ORCHESTRATION_COMPONENTS | arch | critical | Several public features advertise behavior that is prompt-only, inert, or unsupported, creating high product and operator risk. |
| 3 | Durably persist external and asynchronous side effects | SCORERS_EVALUATION | durability | critical | Live scorers, tool calls, OpenAPI calls, hot reloads, and agent side effects need replay-aware persistence instead of fire-and-forget execution. |
| 4 | Generate contracts from canonical schemas | EVENT_TYPES | types | critical | Events, errors, Gateway, HTTP, DevTools, and public declarations drift because schemas, docs, mappings, and runtime validation are manually duplicated. |
| 5 | Close observability catalog and boundary telemetry gaps | OBSERVABILITY | obs | high | Metrics, spans, structured logs, audit events, and correlation fields are inconsistent across CLI, Gateway, MCP, server, sandbox, tools, and workflow packs. |
| 6 | Harden production trust boundaries | AGENT_INTEGRATIONS | security | high | Agent tools, plugins, sandbox providers, VCS paths, token exec, Gateway UI, and Electric proxy inputs need allowlists, containment, redaction, and adversarial tests. |
| 7 | Fix public declarations and JSDoc drift | CLI_INFRASTRUCTURE | jsdoc | high | Empty or stale d.ts files, any-heavy exports, and missing JSDoc weaken the API contract for CLI, engine, components, server, OpenAPI, memory, and plugin consumers. |
| 8 | Create scored eval suites for runtime behavior | WORKFLOW_PACK_PROMPTS | evals | high | The weakest dimension is evals, especially for nondeterministic agents, prompts, workflow packs, scorer behavior, CLI ops, hot reload, and recovery guidance. |
| 9 | Modularize monolithic high-blast-radius entrypoints | CLI_COMMANDS | arch | high | Large engine, CLI, Gateway, semantic server, and renderer modules concentrate risk and make branch-level testing and shared telemetry difficult. |
| 10 | Move workflow-pack side effects into deterministic tasks | BUILTIN_WORKFLOW_PACKS | security | high | Git, release, merge, publish, approval marker, filesystem, and SQL side effects should be typed, validated, idempotent, and approval-gated rather than prompt-only. |
| 11 | Resolve documentation-to-runtime mismatches | MEMORY_SYSTEM | docs | high | Semantic memory, hot reload, external Python workflows, HTTP health, OpenAPI support, usage metering, and Aspects expose claims that implementation does not fully satisfy. |
| 12 | Prove browser, Electric, and sync production paths | ELECTRIC_CLIENT_SYNC | e2e | medium | Client sync, OPFS persistence, Electric source switching, and proxy restart behavior need real browser and backend e2e coverage before production claims are credible. |
| 13 | Strengthen persistence across backends and restarts | DATABASE_PERSISTENCE | durability | medium | SQLite is comparatively mature, but crash restart, Postgres/PGlite migrations, sequence allocation, resume claims, and metric assertions still need broader proof. |
| 14 | Add fixture tests for packaging and script behavior | PACKAGE_AND_BUILD | unit | medium | The unit dimension is strongest but still below 70, and build, docs, release, dependency, LLM, and binary-fetch scripts need focused regression tests. |
| 15 | Publish production guides from verified behavior | HTTP_SERVER | docs | medium | Docs should be regenerated from real contracts and cover persistence, recovery, metrics, MCP, Gateway, Electric, scorer, memory, and workflow-pack operations. |