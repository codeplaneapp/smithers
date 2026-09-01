# Changelog

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added the Schema-first `Flow` and pipeable `Node` builders, placement and
  effect annotations, markdown lowering, graph introspection, and digest-free
  key-material handoff.
- Added `Node.priority` and the `Annotations.Priority` key, carried onto the
  graph node and inherited lexically. Priority stays out of key material.
- Added `Node.catch`, which recovers a node's typed failures with a statically
  planned arm, and `Node.fail`, which re-raises from one.
- Added `Node.capture`, which folds the inert values a plan-time function closes
  over into deterministic, cross-process function identity. Unannotated
  functions keep process-local identity.
- Added `Flow.annotate`, which attaches one typed annotation to a flow, and
  `Flow.withFlows`, which replaces the collaborators a flow declares.
- Added the `Digest` module: the synchronous, SHA-256-only `Crypto` service,
  its layer, `runSync`, `digest`, and `canonical`, delegating to
  `@smthrs/crypto`'s `digestSync` and `syncCrypto` and `@smthrs/canonical`'s
  `Canonical` after `@smthrs/keys/Digest` was deleted.
- Added `Graph.maximumGraphDepth` and `Graph.maximumPayloadDepth`, the
  documented bounds `Graph.build` enforces instead of overflowing the host
  stack, and `Graph.isFatalDiagnostic`, which reports whether a diagnostic
  blocks `Graph.keyMaterial`.
- Added the `capability_outside_grant`, `duplicate_node_id`, `invalid_node`,
  `plan_too_deep`, and `payload_too_deep` graph diagnostics, and the
  `unrepresentable_value` node build error.
- Added `model`, `flows`, and `prompt` to the `Flow` value, so a flow declaring
  collaborators alongside a body reports them and `Flow.withFlows` can rewrite
  them.
- Exported `Flow.MakeOptions` and `Graph.EdgeReason`, so a consumer can name
  what `Flow.make` and `Flow.agent` accept, and why one node depends on
  another, without reaching for `Parameters<typeof Flow.make>[0]`.

### Fixed

- Replaced the provisional `skill_parser_not_implemented` failure with complete
  Agent Skills YAML parsing. Callers now receive the stable
  `skill_missing_frontmatter`, `skill_invalid_frontmatter`,
  `skill_missing_name`, and `skill_missing_description` error codes.
- Made the plan-value projection injective. A `Date`, `Map`, `Set`, typed array,
  `RegExp`, or `Error` used to reflect to `{}`, every function to one constant
  tag, and two distinct symbols to the same value, so behaviorally different
  plans shared one content step key. Encoder tags are no longer forgeable from a
  user literal, own `__proto__` data properties survive, accessors are recorded
  rather than invoked, and a value the projection cannot represent is refused
  instead of collapsed.
- Fixed `Node.capture` of an already-captured function, which discarded the
  inner source and captures and produced one digest for every nesting.
- Fixed `Node.all`, which silently dropped a member named `__proto__`, deleting
  an executable branch with no error.
- Fixed `Effects.covers` for the universal `**` glob, which matched nothing and
  therefore turned an "anywhere" envelope into a spurious
  `effect_outside_envelope` diagnostic on every child step. A path containing a
  `.` or `..` segment is now never covered, so a declaration can no longer
  escape its own envelope.
- Fixed `Node.withEffects` on non-work nodes: the declaration was checked and
  projected, then dropped from key material, so two nodes with opposite
  declarations were byte-identical.
- Fixed `Flow.make`, which discarded `model`, `flows`, and `prompt` whenever
  `body` was present, making every `flows:` declaration in `@smthrs/patterns`
  dead configuration and `Flow.withFlows` a no-op on body flows.
- Fixed `Flow.make` capability normalization, which disagreed with
  `Flow.withCapabilities`, and the unnamed-flow `name` property, which was an
  own enumerable `undefined`.
- Fixed `Graph.keyMaterial`, which compiled step keys for a graph the builder
  had already recorded as invalid. Fatal diagnostics now block key material and
  are returned unchanged.
- Fixed `Node.all` member ordering, which leaked a record literal's insertion
  order into content step keys, and `schemaIdentity`, which collapsed branded
  and annotated schemas onto one empty JSON Schema document.
- Fixed silent capability attenuation: a capability a callee declares and its
  caller does not grant now records a `capability_outside_grant` diagnostic, and
  a flow called from a bare-node root keeps the capabilities it declares.
- Fixed envelope-narrowing diagnostics, which omitted the `nodeId` their own
  schema provides.
- Fixed `Markdown.parseSkill`, whose `extra` record could have its prototype
  replaced by a `__proto__` frontmatter key, and whose invalid-frontmatter
  message echoed the offending source line into a public error.
- Fixed `Markdown.lowerMarkdown`, which fabricated an empty hermetic envelope
  for a markdown flow that declared none, so the lowered flow stopped
  inheriting its caller's envelope.
- Replaced raw host `TypeError`s with package-shaped failures for a
  non-function passed to `Node.capture` and a malformed AST passed to
  `Graph.build`, and replaced the host stack overflow on a deep plan with coded
  `plan_too_deep` and `payload_too_deep` diagnostics.
- Detected colliding structural node ids, which previously dropped a node's key
  material without a word, as a `duplicate_node_id` diagnostic.

### Changed

- A built graph is now deeply frozen, so `Graph.nodes`, `Graph.edges`,
  `Graph.conflicts`, and `Graph.diagnostics` can no longer be used to edit the
  plan being observed.
