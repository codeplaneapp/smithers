# How this wiki stays accountable

This wiki is a repository recipe over ordinary Smithers flows. It adds no wiki database, queue, lease service or generic gateway. The catalog is the repository-specific part; source capture, per-page review and snapshot writing use existing Effect and Flow primitives.

## Capture exact public inputs

Each catalog page names its owning Markdown and code files. The collector only reads repository-relative text files, rejects paths outside the source root and refuses common private/runtime paths. Symlink resolution cannot escape that root. The recipe's catalog contains only public engineering source; the private Smithers-Ops vault is never an input.

Full-file digests and the page specification define each input identity. The snapshot stores complete source files, not just links to a moving branch. Its source revision is a content-addressed working-tree snapshot; it does not claim that the tree matched a Git or JJ commit. Evidence is bounded per file and page. Explicit catalog excerpts reduce reviewer context while preserving original line numbers; edits outside those excerpts still invalidate the whole source identity.

## Review meaning, not hashes

The preview mode produces an explicitly unreviewed artifact. Verified mode invokes a real `AgentAction` reviewer with the page and its exact source evidence. Every section requires a supported result, an explanation and exact source citations. A deterministic step checks section coverage and citation integrity.

The writer checks the source again after review. Changed inputs invalidate the attempt. Unsupported or uncertain sections leave a reviewable artifact and fail the verified flow. A passing model review is recorded evidence, not a formal proof, a passing test suite or a deployment receipt.

## Preserve intent and atomic publication

Generated pages use this recipe's `generated-` slug prefix; that is a naming convention, not a server-enforced reservation. Their front matter records source, content and review digests. Human intent belongs outside the generated inventory. The local writer installs an immutable snapshot directory before atomically updating one current pointer; it does not rewrite human pages.

The local generation flow does not implement cloud publication or CRDT synchronization. Its output defines an integration policy for a future publisher: accept only a verified snapshot, compare the existing page to its last accepted generated body digest, and use the destination's revision precondition. A manually changed generated page must be treated as a conflict to resolve, not permission to overwrite human edits. This policy does not assert that a cloud publisher already enforces it.
