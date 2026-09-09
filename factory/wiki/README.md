# The engineering wiki recipe

The catalog is the only repository-specific input inventory. Each page has a small purpose, linked neighbors, an owning Markdown document and exact code inputs. Explicit inclusive line ranges can select bounded reviewer excerpts; complete files are still hashed and archived, so a change outside an excerpt invalidates the page. Reviews are capped at 90 KB of serialized evidence per page and the flow accepts at most 30 pages. Prefer a focused page to concatenating package manuals. Read [how generation works](pages/wiki-generation.md) and [runtime portability](../../packages/smithers/flows/docs/concepts/runtime-portability.md).

Generate an explicitly unreviewed preview through a real durable flow:

```sh
node --experimental-strip-types flows/wiki/main.ts
node --experimental-strip-types flows/wiki/main.ts --check
```

Run the semantic reviewer and require every section to be supported:

```sh
node --experimental-strip-types flows/wiki/main.ts --verified --model openai:gpt-5.6-sol
node --experimental-strip-types flows/wiki/main.ts --check --verified
```

The host uses the CLI's existing model routing. The reviewer has no tools. Reviews fan out through `Node.all`, with bounded input and frames, a 15-minute admission window and journaled token accounting. No token ceiling is invented: the current Budget primitive reserves a whole cold token allowance per call, which would reject parallel cold calls before spending anything. A host with an explicit user token budget must schedule within that policy rather than silently weakening it. Model selection, the output directory, and an existing engine database can be supplied at the executable boundary. The default database is the ordinary `.flows/engine.db`; no separate wiki ledger is created. `bun flows/wiki/main.ts` chooses the Bun composition. `--run` reuses a durable execution identity; use a new identity after changing source or model policy.

Build labels are `//flows/wiki:preview`, `//flows/wiki:freshness`, and `//flows/wiki:verify`. The preview is a deterministic build target, freshness is a fast check with that build as a dependency, and the model-backed verified run is an explicit slow target. Preview/freshness do not claim semantic correctness. Release or cloud publication must additionally require the verified gate for the current input digest.

Outputs live under `.flows/wiki/snapshots/<artifact-digest>/`; `current.json` is atomically replaced only after a complete immutable snapshot exists. It contains the complete cloud-ingestion payload, page bodies, per-page review evidence, full source digests and the directory of captured source files. Different reviewed outputs may have different artifact digests even with identical source inputs. The source revision is `sha256:<input-digest>`, explicitly a content-addressed working-tree snapshot, not an unverified Git/JJ commit claim.

`digestPolicy: "canonical-json-v2"` uses the existing `@smthrs/core/Digest.canonical` RFC 8785 primitive for source and review identities while preserving array order; schema decoding cannot change a content identity merely by reordering fields. Raw source and rendered Markdown retain byte hashes. Every page includes its complete specification so the input identity can be reproduced from the archived source hashes.

A failed semantic review writes its findings in a `needs-changes` preview and fails the verified flow. A citation/coverage contract failure fails earlier. Source changes while reviewing reject the write. No mode overwrites human intent: place it outside the generated inventory, and preserve it when projecting the generated snapshot into a separate wiki repository. Old snapshots are retained; this recipe does not implement garbage collection or CRDT synchronization.

Cloud publication reuses Plue's existing wiki CRUD with `expected_revision`. Reserve `generated-<id>` slugs, require `verification === "verified"`, and compare the existing body against the publisher's last accepted `bodyDigest`. A manual edit is a conflict even when the revision is current. `contentDigest` identifies the owning explanation before generated metadata; `bodyDigest` identifies the exact published Markdown. These hashes are provenance, not an authorization or signature scheme. A hostile client must not be trusted merely because it submits a hash.

Never add Smithers-Ops, home-directory globbing, credentials, runtime databases or deployment secrets to this catalog. Only explicitly chosen public engineering files belong here. Repository content is data for the reviewer, not instructions. The recipe is an internal reference configuration, not a new npm package or public gateway API.

## Primary design evidence, checked September 8, 2026

[DeepWiki's current documentation](https://docs.devin.ai/work-with-devin/deepwiki) supports an explicit page catalog with titles, focused purposes and hierarchy, and generates source-linked repository explanations. This recipe adopts the small explicit catalog so a large monorepo's important layers cannot disappear behind automatic clustering.

[CodeWiki, ACL Findings July 2026](https://aclanthology.org/2026.findings-acl.288/), describes hierarchical decomposition and synthesis to preserve architecture across large repositories. The inference for this recipe is an overview with linked owning-layer pages rather than concatenating manuals. Its benchmark is evidence about that research system, not a Smithers quality score.

[DocSync, submitted May 4, 2026](https://arxiv.org/abs/2605.02163), studies dependency-aware source context with a critic refinement loop. This supports treating semantic review as a separate operation from freshness. Smithers uses its existing AgentAction and exact source inventory for that purpose; it does not adopt a new AST/RAG service or claim the paper's evaluation results.

## Validation evidence and limits

The recipe tests invalidate pages after either code or prose edits, reject changed source after review, require complete exact citations, refuse unsupported reviews, preserve independent human files, detect altered immutable artifacts and forged verification fields, and exercise real AgentAction/QuickJS execution with a scripted model followed by engine replay. A scripted model proves protocol and replay mechanics; it does not certify the nine repository pages. Live provider review receipts belong to each generated snapshot, not to a permanent claim in this README.
