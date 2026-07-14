# 🧹 errors: SmithersError's options-vs-cause heuristic silently drops plain-object causes that own a name/cause key

GitHub: https://github.com/smithersai/smithers/issues/594

**What happens**
`SmithersError`'s 4th constructor arg is classified as an options bag whenever it is a non-Error object owning any of `cause`/`includeDocsUrl`/`name` (packages/errors/src/SmithersError.js:30-38). The comment (lines 26-29) documents this as intentional back-compat: "most plain-object causes still round-trip as the cause."

**Why it matters**
A deserialized error record used as the cause — e.g. `errorToJson` output, which ALWAYS has `name` + `message` — is misread as options: `new SmithersError(code, summary, details, {name: "TypeError", message: "boom", stack})` silently drops the intended cause (`options.cause` is undefined) and the dead error's `name` hijacks `this.name`. No error, no warning; the causal chain just vanishes from logs and errorToJson output.

**Expected / discussion**
Either (a) tighten the heuristic (e.g. an object with `message`/`stack` alongside `name` is a cause, not options), (b) move to an unambiguous options-only 4th arg in the next major, or (c) keep the heuristic but document the sharp edge on `SmithersErrorOptions` so callers know to wrap such causes as `{ cause }` explicitly.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 4df6fabf183bbaa5a9af41fcba1f881e975528b5.
