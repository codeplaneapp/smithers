# @smthrs/capability

**Documentation:** https://capability.smithers.sh

Capability values and permission failures: the leaf vocabulary of the Smithers
permission kernel.

This package holds **only** the words, never the enforcement. `@smthrs/kernel`
owns the `GrantStore`, the decorating layers, and the journal; this package owns
the `Capability` value, its wildcard `CapabilityPattern`, the effect tiers, and
the three typed failures a guarded Host call can add:

| Module       | Contents                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Capability` | `Capability`, `CapabilityPattern`, `Action`, `PatternAction`, `EffectTier`, `TierOptions`, `maxResourceLength`, `maxMatchWork`, `make`, `format`, `parse`, `parsePattern`, `patternFromCapability`, `withinMatchBudget`, `matches`, `subsumes`, `tierOf`, `requiresIdempotencyKey`.                              |
| `Permission` | `PermissionRequired`, `PermissionDenied`, `GrantStoreError`, `GrantStoreErrorCode`, the `PermissionError` union and its schema, `Rule`, `RuleEffect`, `evaluate`, `permissionRequired`, `permissionDenied`, `isPermissionError`, `formatError`, `maxDisplayFieldLength`, `toPlatformError`, `fromPlatformError`. |

Full reference: <https://capability.smithers.sh/reference/api/>.

## Why it is its own package

A protected Host service declares permission failures in **its own** interface:
`@smthrs/jj`'s `Jj` fails with `JjError | PermissionError`, not with a widened
copy of itself minted by the kernel. That would make `@smthrs/jj` depend on
`@smthrs/kernel`, which already depends on `@smthrs/jj`. Both depend on this
leaf instead, and it depends on nothing but `effect`, so the browser bundle is
unaffected.

Schema ids (`@smthrs/capability/Capability`, `@smthrs/capability/PermissionDenied`, and the rest)
are digested into step keys and round-trip through the grant journal, so
renaming one invalidates recorded runs.

## Contracts

These behaviours decide authorization and durability. They are pinned by tests
and stated on the exported symbols; this list is the short form.

**Text form.** `format` renders both a `Capability` and a `CapabilityPattern` as
`action:resource` and throws on an action outside the closed vocabulary. `parse`
reads back an exact capability and `parsePattern` reads back a pattern. Both
require every component and return `Option.none()` on anything else, including a
missing resource. The action is the first two colon-separated components, except
for the whole-authority selector `*`, which is the first component alone; all
remaining text, colons included, is the resource.

```ts
import { Capability } from "@smthrs/capability"

Capability.format(Capability.make("net:get", "example.test:8443/api:v1"))
// "net:get:example.test:8443/api:v1"
Capability.parsePattern("*:**")
// Option.some(CapabilityPattern { action: "*", resource: "**" })
Capability.parse("fs:read")
// Option.none()
```

**Glob grammar.** `*` matches any run of UTF-16 code units, path separators and
newlines included. `?` matches exactly one code unit, so an astral character
needs two. A pattern ending in a space and `*` also matches the bare resource
without its argument text, which is what makes the `proc:spawn` grant
`npm *` grant bare `npm`. `**`
is the only form `subsumes` can prove, so a grant written with `*` matches but
can never be shown to cover anything, and an envelope built from `*` patterns
re-prompts forever.

**There is no escape.** A resource that genuinely contains `*` or `?` cannot be
granted exactly, so `net:get:https://api.test/v1?k=1` reads as an exact URL and
is a one-character wildcard. Never build a pattern by concatenating
agent-supplied text. `patternFromCapability` derives the exact grant and returns
`Option.none()` for a resource the grammar cannot express.

**Paths and case.** Matching compares the pattern against the whole resource
byte-exactly over UTF-16 code units. It performs no path normalization and no
case folding, so `\` is an ordinary character that never matches `/`, and
`A:/x` never matches `a:/X`.

**Size and cost.** Matching costs O(pattern length times resource length) in the
worst case. Exact and pattern resources reject anything longer than
`maxResourceLength` (4096 UTF-16 code units) at construction and decode.
Adapters reject or summarize larger host values before authorization.
`maxMatchWork` is the fail-closed guard for unchecked structural inputs;
`withinMatchBudget` reports the case and `evaluate` denies it.

**Tiers.** `tierOf` decides containment lexically, so it cannot see symlinks: a
caller that materializes snapshots resolves real paths first. A `workspaceRoot`
that normalizes to `.` or the empty string has no boundary and fails closed to
`irreversible`, so pass an absolute root. Only `irreversible` effects require an
idempotency key to retry.

**Errors.** `isPermissionError` validates the whole shape, not the `_tag` alone,
because the package ships dual cjs and esm and class identity is not stable for
a dual-package consumer. `PermissionRequired.meta` accepts only
JSON-representable values, drops undefined-valued object properties, snapshots
the result deeply, freezes the snapshot, and never retains the caller's object.
Undefined array elements are still rejected. Permission failures defensively
copy capabilities, and their `capability` and `meta` data slots are
non-writable. A value the journal could not encode fails at the construction
site naming the key. `formatError` escapes C0 and C1 controls and caps each
field at `maxDisplayFieldLength`, so an agent-chosen resource cannot forge extra
log lines.

## Documentation

Every page of <https://capability.smithers.sh> is written in this package's
`docs/` directory, and that directory is the only place to edit them. After
changing a page, run `pnpm exec dprint fmt 'docs/**/*.md' 'README.md'` here,
then `pnpm --filter @smithers/docs-capability sync:docs` from the repository
root to stitch the site. `apps/docs/shared/AUTHORING.md` is the contract for
file placement, frontmatter, and links.
