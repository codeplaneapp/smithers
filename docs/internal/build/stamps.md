# Build stamps

`S.Stamp.version`, `commit`, `commitDate`, `buildTime`, and `versionMeta` are inert values used in a Go binary's `stamp` map. They resolve immediately before spawn, after the content key is complete. A stamp may also be a public literal string. Secrets are deliberately rejected: a value embedded in a binary has crossed into the job and its cache artifact, while Smithers secrets may be resolved only by the outbound proxy at the I/O boundary.

The split follows Bazel workspace-status semantics: stable source/tool inputs determine the reusable build key, while volatile provenance is injected into the link command. A cache hit restores the captured binary without re-reading stamps.
