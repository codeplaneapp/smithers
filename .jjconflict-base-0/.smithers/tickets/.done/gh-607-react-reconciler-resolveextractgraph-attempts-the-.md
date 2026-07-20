# 🧹 react-reconciler: resolveExtractGraph attempts the dev-only local graph import even after the package specifier resolves

GitHub: https://github.com/smithersai/smithers/issues/607

**What happens**
`packages/react-reconciler/src/core-peer.js:22-26` builds `modules` by awaiting **both** `importModule("@smithers-orchestrator/graph")` and `importModule("../../graph/src/index.js")` before checking either for `extractGraph`.

**Why it's wrong / failure scenario**
In published installs the relative `../../graph/src/index.js` path never exists, so every `resolveExtractGraph()` call (each render without an explicit extractGraph) performs a failing dynamic import that is swallowed by `importCoreModule`'s catch — wasted module-resolution work and noisy loader errors under debugging, purely to support the in-repo dev fallback.

**Expected behavior**
Try the package specifier first and return early on success; only attempt the local dev fallback when the package specifier fails.

Note: reordering changes the observable sequence of import attempts, so land it with a test touch rather than as a drive-by.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in c7cc5bad2f19e6770323c83acad774f132c7950a.
