---
description: "The rules new code follows: make invalid data unrepresentable and keep the code that operates on it small."
---

# Code design

Make invalid data unrepresentable and keep the code needed to operate on it as small as possible.

- Start with data. Model public values with Effect Schema, including validation, normalization, branding, encoding, and transformations between representations.
- Prefer schema decoding over constructor and helper functions. A transformation such as `Schema.decodeUnknownEffect(Key)(input)` is the API.
- Put invariants in the storage layer. Use SQL types, constraints, unique indexes, foreign keys, and atomic statements instead of rechecking durable facts in application code.
- Use Effect for dependencies and failures. Inject platform services such as cryptography, clocks, filesystems, and databases; keep errors typed.
- Use well-tested libraries for security-sensitive and standards-based behavior. Wrap the library with the project type or schema instead of reimplementing it.
- Delete indirection. Do not keep wrappers, aliases, compatibility exports, one-line forwarding functions, or public helpers that add no invariant.
- Keep implementation details private and mark package-private declarations with `@private`.
- Give each public concept one name and one owning file. Prefer composing small schemas over adding procedural utility modules.
- Normalize exactly once at the boundary where data acquires its type. Downstream code should operate on validated, normalized values.
- Preserve behavior with boundary, failure, and round-trip tests. Test public contracts rather than implementation details.
- Delete obsolete code and tests immediately after replacing an API. This repository is unreleased, so internal compatibility is not a goal.
