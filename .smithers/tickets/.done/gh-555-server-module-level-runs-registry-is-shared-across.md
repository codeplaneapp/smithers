# 🐛 server: module-level `runs` registry is shared across startServer instances — closing one server aborts the other's runs

GitHub: https://github.com/smithersai/smithers/issues/555

**What happens**
`const runs = new Map()` lives at module scope (packages/server/src/index.js:45), but `startServerInternal` (index.js:712) can be invoked multiple times in one process via the public `startServer`/`startServerEffect` API. All server instances share one registry.

**Why it's wrong / failure scenario**
The `server.on("close")` handler (index.js:1357-1364) iterates the shared map, calls `record.abort.abort()` and deletes EVERY tracked run — including runs started and still owned by a different, still-listening server instance. `adapterForRun` also resolves records across instances, blurring per-server run attribution.

**Expected**
The run registry should be created inside `startServerInternal` so each server owns (and on close, aborts) only its own runs.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 755dfbeb6559aecaf4ddb8b35c0ce60b8afab330.
