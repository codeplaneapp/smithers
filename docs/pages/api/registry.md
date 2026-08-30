---
description: "@smthrs/registry: flow discovery over flows/**, the descriptors it produces, and the catalog a host registers."
---

# `@smthrs/registry`

This page is the public API reference for **flow discovery and the catalog a
model is shown**: portable descriptors scanned off a filesystem, disclosed to
an agent in a compact form, and resolved back to a runnable body on demand.

Discovery is metadata-only. Scanning a source parses Markdown frontmatter and
module metadata without evaluating a module or reading a prompt body, so a
catalog of a thousand flows costs a thousand frontmatter parses and no imports.
A body is loaded when a flow is actually invoked.

## Descriptor

`FlowDescriptor` is the serializable unit: a name, its schema references, its
declared effects and placement, a `BodyRef` naming where the body lives, and a
`Provenance` recording the source and root it came from. `SourceScan` pairs the
descriptors a source yielded with the `DiscoveryWarning`s it produced, such as
a duplicate name, an unparseable frontmatter block, or an unreadable file. A
scan that dropped an entry must say so rather than return a shorter list.

`Provenance.pack` names the pack a descriptor came from, when it came from one.
It is absent for every descriptor a plain source produced.

## Discovery and Registry

`Discovery.scan(source)` reads one source. `Registry` is the service the harness
consumes: `list`, `visible`, `getOption`, `body`, `refresh`, and `warnings`.

Three constructors build one:

- `Registry.layer(config)` scans ordered sources, first-found wins.
- `Registry.layerFromDescriptors(entries, warnings?)` takes an in-memory
  snapshot and still loads bodies lazily.
- `Registry.layerFromPacks(packs, { runtimeVersion })` merges a set of packs.

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

`Pack.read(fs, path, dir)` decodes the manifest and fails
`RegistryError { code: "invalid_pack" }` when it is missing, unparseable, or
incomplete. Nothing half-loads: the manifest is what names the pack in every
descriptor's provenance.

`Pack.digest(manifest, files)` is the content address a lock file records. It
covers the manifest and every measured file by its own hash under its
pack-relative path, so reading the same bytes in a different order produces the
same digest and editing one flow body changes it.

`Registry.layerFromPacks` applies three rules:

- **Precedence is the origin, not the list order.** Every `local` pack outranks
  every `installed` one, so a project pack shadows a vendored flow of the same
  name wherever the host happened to list it. An ordered source list cannot
  express this: it merges first-found, so an installed source listed first wins
  a name the project defines.
- **A shadowed flow is reported.** The loser becomes a
  `DiscoveryWarning { code: "shadowed" }` naming both packs and versions, read
  back through `registry.warnings()`.
- **Compatibility is checked before anything is scanned.** A pack whose
  `requires.smithers` range this runtime does not satisfy fails
  `RegistryError { code: "incompatible_pack" }` at load, not at the first call
  into one of its flows. The grammar is `*`, an exact version, and the `>=`,
  `>`, `<=`, `<`, `^`, `~` comparators joined by spaces as a conjunction.
  `^` and `~` read the way npm reads them. `^` allows everything up to the next
  bump of the left-most non-zero field, so `^1.2.0` accepts `1.9.0`, `^0.2.3`
  accepts `0.2.9` and refuses `0.9.0`, and `^0.0.3` accepts only `0.0.3`; `~`
  pins the minor, so `~1.2.0` accepts `1.2.9` and refuses `1.3.0`.
  A range the parser cannot read is refused rather than assumed compatible,
  because guessing loads a pack against a runtime it was never written for.
  Prerelease and build suffixes are ignored on both sides, so a `1.0.0-rc.4`
  runtime satisfies a range written against `1.0.0`.

The rest of the pack surface:

| Export | What it is |
| --- | --- |
| `Pack.compatible(range, version)` | The range check above, as a predicate. |
| `Pack.checkCompatible(manifest, runtimeVersion)` | The same check as an effect that fails `RegistryError { code: "incompatible_pack" }` naming the pack, its range, and the runtime. |
| `Pack.attribute(descriptor, pack)` | Stamps one descriptor's `Provenance.pack` with the pack that supplied it. |
| `Pack.sources(packs)` | The discovery sources a pack list contributes, flows and skills directories alike. |
| `Pack.merge(scans)` | Applies the precedence and shadowing rules above to already-scanned packs. |
| `Descriptor.PackRef` | The `{ name, version, origin }` a stamped descriptor carries, so a catalog entry says which pack it came from. |

The `pack add | remove | list | update | eject` verbs are CLI surface and are not
part of this package. This is the runtime contract underneath them: it reads
manifests from directories a caller names and holds no filesystem policy of its
own.
