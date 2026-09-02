## The eight modules

| Module          | What it owns                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Descriptor`    | The serializable `FlowDescriptor` and every value it is built from: schema references, body references, effects, provenance, budgets, and discovery warnings. |
| `Discovery`     | The `Discovery` service that walks one source root and produces a `SourceScan`.                                                                               |
| `MarkdownFlow`  | Markdown and Agent Skills compatibility: frontmatter to descriptor, body loading, and prompt rendering.                                                       |
| `Registry`      | The refreshable, first-found-wins catalog a harness consumes, plus its layers.                                                                                |
| `Disclosure`    | The compact projections a model and a slash-autocomplete list are shown.                                                                                      |
| `Executable`    | Turning one descriptor into a runnable `@smthrs/flow` value, and the `Invocation` envelope a delegate receives.                                               |
| `Pack`          | Manifests, content addresses, compatibility ranges, and the precedence rules a shareable pack brings.                                                         |
| `RegistryError` | `DiscoveryError` and `RegistryError`, their stable codes, and their constructors.                                                                             |

## Descriptor

`FlowDescriptor` is the serializable unit: a name, its schema references, its
declared effects and placement, a `BodyRef` naming where the body lives and the
SHA-256 of the bytes discovery read, and a `Provenance` recording the source and
root it came from. `SourceScan` pairs the descriptors a source yielded with the
`DiscoveryWarning`s it produced, such as a duplicate name, an unparseable
frontmatter block, or an unreadable file. A scan that dropped an entry must say
so rather than return a shorter list.

`Provenance.pack` names the pack a descriptor came from, when it came from one.
It is absent for every descriptor a plain source produced.

`BodyRef.contentDigest` is the content address of the whole entry file. It is
what makes a lazily loaded body honest: `Registry.loadBody` and
`Executable.fromDescriptor` rehash the bytes they read and fail
`body_unavailable` when the file changed after discovery, rather than running a
body whose declaration the catalog no longer describes. Refreshing the registry
is what adopts the new bytes.

## Snapshot ownership

A registry owns everything it hands out. `Registry.layer`, `layerFromPacks`, and
`layerFromDescriptors` copy each descriptor and every array, record, and option
inside it, then freeze the copy, and they snapshot the configuration they were
given. Two consequences a caller can rely on:

| Action                                                                         | Effect on later reads                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Mutating a descriptor a caller passed to `layerFromDescriptors`                | None. The registry answers from its own copy.                             |
| Mutating a descriptor returned by `list`, `visible`, or `get`                  | Rejected: returned descriptors are frozen.                                |
| Mutating the `sources` or `packs.installed` array after construction           | None. The configuration was snapshotted.                                  |
| Mutating an `Invocation` a delegate received, or the input object passed to it | Rejected: the envelope, its arrays, and its JSON input are frozen copies. |

The envelope matters twice over, because the same values are captured as the
delegating node's durable identity. Freezing them is what keeps the envelope a
delegate reads and the key material the engine recorded from diverging.

The guarantee has a cost, and it is bounded: one traversal per descriptor per
`refresh`, through a single identity map, over metadata the scan already parsed.
There is no extra file-system work and no body is read, so a refresh still costs
one frontmatter parse per flow plus one copy of what that parse produced. The
single map is also what keeps a value two fields reference from coming back as
two objects.

## Declaring a budget

A markdown flow declares what a control plane should approve for one of its
runs:

```yaml
---
description: Reviews a proposed change.
budget:
  tokens: 120000
  milliseconds: 900000
---
```

The two fields are the two fields of a control-plane `Envelope.budget`, so a
host projects `FlowDescriptor.budget` into an approved envelope without
reinterpreting either number. `@smthrs/agent`'s `Budget.layerFromEnvelope` turns
that envelope into enforcement at the model boundary. The local CLI does exactly
this: `NodeControl.durableFlow` reads the budget with `Descriptor.budgetOf` and
the executor binds `Budget.layerFromEnvelope`, so a declared ceiling reaches the
run that spends against it.

Both ceilings are positive safe integers. The schema refuses zero, a negative
number, a fraction, `NaN`, and a value past `Number.MAX_SAFE_INTEGER`, so an
invalid ceiling cannot be decoded into a descriptor and projected across a
package boundary.

`budget` is absent for a flow that declares none. `Descriptor.budgetOf` answers
that absence with `Descriptor.budgetUnbounded`, so giving up a ceiling is a
named value a reader can see rather than an empty object nobody wrote. Both the
shared unbounded value and every budget `budgetOf` returns are frozen: one host
cannot rewrite the ceiling every other undeclared descriptor reports.

A malformed budget is dropped rather than tightened, and dropping it produces a
`DiscoveryWarning { code: "invalid_budget" }`. Every other malformed field has a
conservative reading to fall back on; a budget has none, because its
conservative number is zero and a zero ceiling refuses the run's first call. A
ceiling is a number greater than zero, and each of the two is read on its own,
so an unreadable `tokens` does not discard a valid `milliseconds`. A key the
budget does not know is reported the same way, because a misspelled `tokens`
would otherwise read as an unbounded run in silence.

Module flows declare no budget. Discovery reads a `flow.ts` without evaluating
it, and `budget` is absent for every descriptor it produces, so a module flow
runs unbounded unless its host supplies a budget of its own.

## Delegated authority

A descriptor that names a delegate flow inherits authority discovery cannot
read. Both the markdown and the module path route that case through one
conservative projection: wildcard capabilities `["*"]`, wildcard `reads` and
`writes` `["**"]`, `mode: "expected"`, and `tier: "irreversible"`, reported as a
`DiscoveryWarning { code: "unprojectable_authority" }`. A declared `sealed` tier
on such a flow is reported as under-classifying rather than accepted.

This is the admission contract, not a cosmetic label.
`Executable.dispatchedAction` puts `effects.tier` on the dispatched action, and
`@smthrs/engine-store`'s `ActionPersistence` reuses a `sealed` dispatch and
refuses anything else. Projecting an indirectly writing flow as sealed would
both cache it as reusable and disclose it to a model as read-only.

`Discovery` infers a tier from projected capabilities when a flow declares none.
Only a relative `fs:write:<resource>` path with no home marker, no variable
reference, and no URI scheme is compensable; `~/…`, `$HOME/…`, `${HOME}/…`,
`%USERPROFILE%\…`, `file:///…`, an absolute path, and a path that escapes the
workspace with `..` are all irreversible.

## Discovery and Registry

`Discovery.scan(source)` reads one source. `Registry` is the service the harness
consumes, and it has eight members: `list`, `visible`, `get`, `getOption`,
`loadBody`, `runPrompt`, `refresh`, and `warnings`.

Three constructors build one:

- `Registry.layer(config)` scans ordered sources, first-found wins.
- `Registry.layerFromDescriptors(entries, warnings?)` takes an in-memory
  snapshot and still loads bodies lazily.
- `Registry.layerFromPacks(packs, { runtimeVersion })` merges a set of packs.

`refresh` rescans every configured source and replaces the snapshot only after
all of them succeed, so a failed rescan leaves the previous complete snapshot
serving reads rather than emptying the catalog.

Discovery follows symbolic links wherever the host `FileSystem.stat` does, which
is what the ordinary Node file system does. Two guards bound the walk: a
visited-directory identity set, keyed on device and inode, refuses to descend
into a directory already visited and reports `symlink_cycle`; and a 32-segment
depth ceiling reports `max_depth_exceeded` and stops. Without them a single
`flows/a/b/loop -> flows` link yields one flow many times over and terminates
only when the operating system raises `ELOOP`.

### Resource ceilings

| Ceiling                           | Value       | What it bounds                                                                                                                                                                                                            |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Discovery.entrySizeLimit`        | 4 MiB       | The size of an entry file discovery will admit. A larger file is skipped with `entry_too_large` and contributes no descriptor, so a stray build artifact under `flows/` cannot exhaust the process at layer construction. |
| `Discovery.maximumTraversalDepth` | 32 segments | How deep a source walk descends. The entry-name path is the flow name, so a deeper tree is a loop or a mistake.                                                                                                           |
| Metadata parse ceiling            | 64 KiB      | How much of an admitted file is parsed looking for frontmatter or module metadata. It bounds parsing only; the size ceiling above is what bounds input.                                                                   |

The size ceiling is checked twice, because the first check trusts the host. A
`stat` size past the limit skips the file unread, which is the fast path an
ordinary file system takes. The bytes actually read are then measured against
the same limit, so a host whose `stat` under-reports or omits a size still gets
`entry_too_large` with the true byte count, and the entry is refused before it
is hashed, decoded, or parsed. An in-memory or remote `FileSystem` and a special
file are the hosts that need it.

### Failure and warning codes

`Discovery` and `Registry` fail with typed errors that carry a stable `code`, a
`module` and `method`, and, where one is in hand, the offending `path` as a
field rather than only inside the prose message.

| Error             | Codes                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiscoveryError`  | `root_missing`, `read_failed`, `invalid_root`, `unknown`                                                                                        |
| `RegistryError`   | `not_found`, `system_collision`, `body_unavailable`, `not_prompt_flow`, `invalid_pack`, `incompatible_pack`, `unreadable_pack_range`, `unknown` |
| `ExecutableError` | `missing_delegate`, `ambiguous_delegate`, `body_unavailable`, `invalid_module`                                                                  |

Anything a scan can survive is a `DiscoveryWarning` instead, read back through
`registry.warnings()`. The codes are grouped by what they say:

| Group                  | Codes                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming and description | `missing_description`, `invalid_description`, `missing_name`, `invalid_name`, `directory_name_mismatch`, `name_field_ignored`, `duplicate_name`, `root_level_entry`                                                                                 |
| Declaration fields     | `unknown_frontmatter_key`, `invalid_allowed_tools`, `invalid_capabilities`, `invalid_budget`, `invalid_model_invocation`, `invalid_compatibility`, `invalid_license`, `invalid_metadata`, `unsupported_input_schema`, `unsupported_module_metadata` |
| Authority              | `unprojectable_authority`, `invalid_effect_declaration`, `invalid_effect_tier`                                                                                                                                                                      |
| Source shape           | `multiple_entry_files`, `frontmatter_parse_error`, `non_serializable_frontmatter`, `symlink_cycle`, `max_depth_exceeded`, `entry_too_large`, `unreadable`                                                                                           |
| Packs                  | `unknown_pack_key`, `shadowed`                                                                                                                                                                                                                      |

### Text, frontmatter, and XML

| Surface                    | Behaviour                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontmatter parsing        | YAML on the failsafe schema. Every mapping is built with a null prototype and frozen, so a `__proto__`, `constructor`, or `prototype` key is retained as an ordinary own key and can never install inherited metadata that the descriptor's digest cannot see.                                                   |
| Malformed frontmatter      | Reported as `frontmatter_parse_error` with a bounded line-and-column summary. The offending source line is never quoted and the raw parser error is not attached, because unknown frontmatter is retained verbatim and may hold a secret.                                                                        |
| Non-serializable values    | Replaced with `null` and reported once as `non_serializable_frontmatter`.                                                                                                                                                                                                                                        |
| `Disclosure.toXml`         | Replaces every code point XML 1.0 forbids, plus lone surrogates and Unicode noncharacters, with U+FFFD before escaping `&`, `<`, `>`, `"`, and `'`. Tab, line feed, carriage return, combining marks, and astral characters survive unchanged, so one malformed description cannot invalidate the whole catalog. |
| `Executable.fileSpecifier` | Percent-encodes exactly what `pathToFileURL` does, so a POSIX path containing a backslash, a control character, a space, or non-ASCII text addresses the file it names. A backslash becomes a separator only in a Windows drive path.                                                                            |

## Running a discovered flow

`Executable.fromDescriptor(descriptor, options)` resolves the delegate, loads
the body, and returns a runnable flow. The delegate is resolved first: a flow
whose delegate nobody registered is not runnable on this host whatever its body
says.

`Invocation` is the fixed envelope every delegate receives, because one delegate
runs many descriptors. It carries the flow name, the caller's JSON input, the
rendered prompt, the model seat, the capabilities and collaborator flows the
descriptor declared, and the placement. Placement travels as two fields:
`placement` names the host kind (`client`, `local`, `sandbox`, or `remote`) and
`placementOptions` carries the `image`, `profile`, and `target` that select it,
or `null` when none were named. Both are read from the lowered placement, so a
`Flow.within(...)` annotation on the loaded body wins over the descriptor's
frontmatter directive in the envelope exactly as it does in the flow annotation
and the durable identity.

`MarkdownFlow.renderPrompt(body, { args })` renders a markdown body for a model.
It appends a fixed block naming where the skill's own files live:

```text
<the body text>

Supporting skill resources are available relative to this skill directory but are not loaded into context unless needed:
<skill_resources>
- Base directory: /absolute/path/to/the/skill
- Resolve relative resource paths from this directory and read only the files you need.
</skill_resources>

<args, when the caller supplied any>
```

The base directory is the absolute host path the descriptor was discovered
under, so a host that must not disclose its filesystem layout to a model should
render the body itself rather than through this helper.

## Packs

A pack is a directory with a `pack.json` manifest. It is the shareable unit a
project installs rather than copies:

```json
{
  "name": "review-pack",
  "version": "1.2.0",
  "flows": ["flows"],
  "skills": ["skills"],
  "requires": { "smithers": ">=1.0.0" }
}
```

`flows` and `skills` are directory paths relative to the pack root, each scanned
exactly the way an ordinary source is. They are paths rather than flow names on
purpose: a manifest listing names would need re-editing whenever a flow was
added, and the pack digest would then not change when one was.

### Path confinement

A pack is third-party content, so this module holds exactly one piece of
filesystem policy: a pack contributes sources only from inside its own root.

| Rule                                                                                                                                    | Where it is enforced                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A manifest entry is a relative path with no empty, `.`, or `..` segment, no NUL byte, no backslash, no leading `/`, and no drive prefix | `Pack.read`, as a decode refusal that fails `invalid_pack` naming the offending entry                             |
| A resolved entry stays under the resolved pack root                                                                                     | `Pack.sources`, so a directly constructed `Installed` value is checked too                                        |
| A resolved entry's real path stays under the pack root's real path                                                                      | `Pack.sources`, wherever the host can answer `realPath`, so a symlinked escape is refused alongside a lexical one |

`Pack.read(fs, path, dir)` decodes the manifest and fails
`RegistryError { code: "invalid_pack" }` when it is missing, unparseable, or
incomplete. Nothing half-loads: the manifest is what names the pack in every
descriptor's provenance. It returns the manifest, the directory, and any
`unknown_pack_key` warnings, because a misspelled `requires` would otherwise
disable the compatibility gate in silence.

`Pack.digest(manifest, files)` is the content address a lock file records. It
covers the manifest and every measured file by its own hash under its validated
pack-relative path, so reading the same bytes in a different order produces the
same digest and editing one flow body changes it. Duplicate paths are ordered by
their content digest rather than by input order. File contents are UTF-8 text;
measuring the files is the caller's job, and the CLI pack verbs are the intended
caller.

`Registry.layerFromPacks` applies three rules:

- **Precedence is the origin, not the list order.** Every `local` pack outranks
  every `installed` one, so a project pack shadows a vendored flow of the same
  name wherever the host happened to list it. An ordered source list cannot
  express this: it merges first-found, so an installed source listed first wins
  a name the project defines.
- **A shadowed flow is reported.** The loser becomes a
  `DiscoveryWarning { code: "shadowed" }` naming both packs and versions, read
  back through `registry.warnings()`.
- **Compatibility is checked for every pack before any pack is scanned.** A pack
  whose `requires.smithers` range this runtime does not satisfy fails
  `RegistryError { code: "incompatible_pack" }` at load, not at the first call
  into one of its flows, and not after the directories of an earlier pack have
  already been walked. The grammar is `*`, an inclusive hyphen range, and
  whitespace-separated conjunctions of bare, `=`, `>=`, `>`, `<=`, `<`, `^`, and
  `~` comparators. Whitespace may separate an operator from its version, and a
  version with one or two components is zero-filled, so `>= 1.0.0`, `>=1.0`, and
  `^1` all read. `^` and `~` read the way npm reads them: `^` allows everything
  up to the next bump of the left-most non-zero field, so `^1.2.0` accepts
  `1.9.0`, `^0.2.3` accepts `0.2.9` and refuses `0.9.0`, and `^0.0.3` accepts
  only `0.0.3`; `~` pins the minor, so `~1.2.0` accepts `1.2.9` and refuses
  `1.3.0`. `x` components and `||` unions are not read. A range the parser
  cannot read is refused rather than assumed compatible, and it is refused as
  its own `RegistryError { code: "unreadable_pack_range" }` so an operator can
  tell a dialect this runtime cannot parse from a pack that genuinely needs a
  newer one. Prerelease and build suffixes are ignored on both sides, so a
  `1.0.0-rc.4` runtime satisfies a range written against `1.0.0`.

The rest of the pack surface:

| Export                                       | What it is                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Pack.compatible(range, runtimeVersion)`     | The range check above, as a predicate. An unreadable range is `false`.                                                                                                   |
| `Pack.checkCompatible(pack, runtimeVersion)` | The same check over one `Installed` pack, as an effect that fails `incompatible_pack` or `unreadable_pack_range` naming the pack, its range, and the runtime.            |
| `Pack.attribute(descriptor, pack)`           | Stamps one descriptor's `Provenance.pack` with the pack that supplied it.                                                                                                |
| `Pack.sources(pack, path)`                   | The confined discovery sources one pack contributes, flows and skills directories alike, as an effect that fails `invalid_pack` for an entry that escapes the pack root. |
| `Pack.merge(scans)`                          | Applies the precedence and shadowing rules above to already-scanned packs.                                                                                               |
| `Descriptor.PackRef`                         | The `{ name, version, origin }` a stamped descriptor carries, so a catalog entry says which pack it came from.                                                           |

The `pack add | remove | list | update | eject` verbs are CLI surface and are not
part of this package. This is the runtime contract underneath them.
