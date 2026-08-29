# Build stamps

`S.Stamp.version`, `commit`, `commitDate`, `buildTime`, and `versionMeta` are inert values used in a Go binary's `stamp` map. They resolve immediately before spawn, after the content key is complete. A stamp may also be a literal string or `S.Secret(name)`; secret values are read from the environment only at spawn and never enter keys, plans, logs, or cache metadata.

The split follows Bazel workspace-status semantics: stable source/tool inputs determine the reusable build key, while volatile provenance is injected into the link command. A cache hit restores the captured binary without re-reading stamps.
