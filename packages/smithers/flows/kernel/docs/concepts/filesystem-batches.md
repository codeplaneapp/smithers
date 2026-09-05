---
title: "Bounded filesystem batches"
description: "Optional read batches on the guarded filesystem, with per-path grants, root identity, explicit failures, and portable fallback."
---

`FileSystem.batch(fs)` from `@smthrs/kernel/FileSystem` discovers an optional
capability on the existing Effect filesystem service. It adds no host slot and
changes no persisted host identity. A native adapter advertises `batchLimits`
on its descriptor-relative executor. The kernel exposes the guarded capability
after binding the workspace root; callers never receive the raw executor.

```ts
const batch = FileSystem.batch(fs)
if (batch !== undefined) {
  const response = yield * batch.execute([
    { operation: "stat", path: "src/a.ts" },
    { operation: "digest", path: "src/b.ts" },
    { operation: "readDirectory", path: "src" }
  ])
}
```

A batch accepts 1 through `maxSize` requests, with a hard maximum of 128.
`maxResponseBytes` bounds the aggregate encoded answer. Inputs are copied
before asynchronous root or permission checks. Every member gets the same
canonical `fs:read` check and post-grant re-resolution as an individual call.
Each grant or quota refusal remains an explicit per-path `Result` carrying its
original `PlatformError`. A batch with no admitted members starts no helper.

Each response carries `rootIdentity`, the root device/inode checked by the
executor. Members retain their original request `index` and normalized `path`,
and sort by path and then index. Successful values discriminate `stat`,
`readDirectory`, `glob`, and `digest`. A digest contains 64 lowercase SHA-256
hex digits, its byte count, and bytes only when requested with `content: true`.
Missing paths report `NotFound`; they are not silently dropped. The engine
decides where absence means an empty expansion or an absent digest.

Root loss or replacement refuses the entire operation. Helper failure,
cancellation, deadline, malformed framing, and aggregate quota exhaustion also
produce no partial batch. Ordinary path failures appear individually so an
unrelated authorized path can still be measured. A batch is not a transaction
or an assertion that the workspace was frozen.

When the workspace root is a symlink, its logical path must still resolve to
the captured root inode before and after grants. Retargeting the alias refuses
the batch even if the original canonical directory still exists. The helper
independently verifies that canonical directory against the same inode.

Hosts may omit the capability. The engine then uses the existing guarded
operations with at most four operations in flight. Isolated test/browser
volumes keep their existing attestation; optional batching does not weaken it.
The shared HostContract exercises each adapter that advertises batching, while
the Node conformance tests additionally exercise the confined helper's fault
and resource boundaries.

Host glob grammar remains host-specific. Declared engine globs continue to use
the plan's matcher, including dotfiles and its metadata-directory pruning, over
batched directory/stat operations.
