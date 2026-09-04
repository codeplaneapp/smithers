---
title: "Testing"
description: "Browser implementations of Effect platform services backed by ZenFS and just-bash"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/testing.md"
---

The package-owned
[`@smthrs/platform-browser` suite](/reference/api/) runs the shared host
contract against `BrowserHost` three ways: the full bundle over the committed
`flows_jj.wasm`, the manual-redirect `HttpClient`, and one real mount shared by
the filesystem, the interpreter, and jj. Beside it, the filesystem adapter is
exercised against a real temp directory for recursive listing, permission
checks, directory modes, symlink and relative canonicalization including a `..`
that follows a link, and bounded streaming with refused bounds, and against stub
backends for every error tag, a looping directory tree, a backend that
misreports a read length, and backends that keep the buffers they are handed
and the containers they answer with, which pin that bytes and names cross the
boundary by value. The spawner suite pins the rendered command line
against the kernel's own renderer with hostile argv tokens, every refused
capability, and the abort boundary: an interpreter that ignores its
`AbortSignal` must not let a second run start, and a killed handle must report a
`PlatformError` rather than interrupt its caller. The barrel suite pins the
namespace universe and the kernel isolation attestation that `layer` makes and
`make` does not.
