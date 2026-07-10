# 🐛 engine: hot WatchTree.waitEffect single-resolver slot — concurrent waiters overwrite each other and interrupt cleanup can clear another waiter's resolver

GitHub: https://github.com/smithersai/smithers/issues/540

**What happens**
`WatchTree.waitEffect` (`packages/engine/src/hot/watch.js:126-145`) stores exactly one resolver in `this.waitResolve`.

1. Two concurrent waiters: the second registration overwrites the first resolver, so the first fiber never resumes even when changes flush.
2. The Effect.async cancellation cleanup (watch.js:137-141) nulls `this.waitResolve` unconditionally — it does not check the slot still holds *this* waiter's resolver. Interrupting waiter A after waiter B has registered discards B's resolver, so B hangs even after `flush()` fires (changes are only buffered into `changedFiles`).

**Why it's wrong / failure scenario**
Any future second consumer of the watch tree (or a race between an interrupted-and-restarted hot-reload loop iteration and its successor) silently hangs the surviving waiter. Latent today — the engine drives a single waiter — but the API gives no hint of the restriction.

**Expected**
Track resolvers per-waiter (a Set) and have each interrupt cleanup remove only its own entry, or explicitly reject a second concurrent `waitEffect`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
