The package-owned
[`@smthrs/platform-browser` suite](/api/platform-browser) runs the shared host
contract against `BrowserHost` three ways: the full bundle over the committed
`flows_jj.wasm`, the manual-redirect `HttpClient`, and one real mount shared by
the filesystem, the interpreter, and jj. Beside it, the filesystem adapter is
exercised against a real temp directory for recursive listing, permission
checks, directory modes, symlink and relative canonicalization, and bounded
streaming with refused bounds, and against stub backends for every error tag,
a looping directory tree, and a backend that misreports a read length. The
spawner suite pins the rendered command line against the kernel's own renderer
with hostile argv tokens, every refused capability, and the abort boundary:
an interpreter that ignores its `AbortSignal` must not let a second run start,
and a killed handle must report a `PlatformError` rather than interrupt its
caller. The barrel suite pins the namespace universe and the kernel isolation
attestation that `layer` makes and `make` does not.
