---
title: "How recall works"
description: "The recall seam in @smthrs/memory: the replaceable service, the three bindings in the box, and the byte budget every answer fits."
sidebar:
  order: 2
---

Recall answers one question: given named banks and a query, which memory rows should the caller see, within budget? The answer is advisory. The store stays authoritative, and a recall binding is a ranking over store rows, never a second copy of them.

## The seam

Recall is two things at once: an Effect service (`Recall.Recall`) with one method, and a flow-valued injection slot (`Recall.slot`) a host binds with `Pattern.bind` from [`@smthrs/patterns`](/api/patterns). The `recall` flow declaration and `Flows.runRecall` both delegate to whichever service the context provides, so swapping the binding swaps the behavior of every caller without touching them.

Three bindings ship in the box:

| Binding          | Extra services it needs        | Ranking                                                         | Pick it when                                                |
| ---------------- | ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `RecallKeyword`  | none beyond the store          | count of normalized query terms found in the row's key and text | you want zero moving parts                                  |
| `RecallFts`      | an FTS-enabled namespace kind  | SQLite FTS5 BM25 rank                                           | you want ranked full text search at store scale             |
| `RecallSemantic` | `Embedding` and a vector store | cosine similarity to the query embedding, decayed by row age    | you want meaning-level matching and accept projection costs |

`RecallKeyword` normalizes both query and row text to NFKC before matching. SQLite full text search does not, so the two bindings can disagree on compatibility-equivalent characters. `RecallFts` quotes each query term independently, so user input can never become an FTS5 operator, and it propagates the store's `fts_not_enabled` error when the namespace kind has not opted in.

`RecallSemantic` answers only rows that hold a current vector under the requested model: foreign-model vectors are skipped, a stale projection whose content digest no longer matches the row is skipped, and a stored vector under the requested model with the wrong dimension fails with `vector_model_mismatch`. The authoritative store writes no vectors itself; projection is opt-in through `RecallSemantic.decorateStore`, which adds an after-commit projection to fact and note writes that retries once and logs failures without changing the write result.

Every binding applies the same filters before ranking: rows pass status, supersession, and tag-group filters from the store's authoritative read, and banks are de-duplicated on the resolved namespace.

## The byte budget

`maxTokens` caps the answer, and it is a byte ceiling, not a token count. `Recall.capRecallResults` measures the UTF-8 bytes of the JSON-serialized result array, because bytes conservatively bound tokens without committing the package to one model's tokenizer. The cap drops rows with empty text first, then selects complete rows greedily in rank order, then truncates only the first row that overflows, by binary search, never splitting a code point. The default budget is 2,048 bytes and the published ceiling is 65,536.

`maxTokens` on the recall input and `Source.Input.maxBytes` are separate ceilings: the first caps recalled rows, the second caps the complete fenced snapshot an agent's opening context renders.

## What a read limit counts

A `limit` on `listFacts`, `listNotes`, `listMessages`, `searchRows`, or `searchFts` bounds the rows the caller receives after every status, supersession, and tag-group filter on the same input. It is not a bound on the rows the query examines, so a bounded read never under-fills while matching rows remain. Statuses and supersession are answered in SQL. Tag groups are evaluated by `Namespace.matches`, the single source of truth for the five match modes, so a tag-filtered read walks the namespace in bounded pages until it has `limit` matches. Working-set memory stays proportional to one page, never to the namespace.

## Score ties

Every binding breaks score ties the same way: newest update first, then ascending key. The order is deterministic, so a replayed recall over unchanged memory returns the same rows in the same order.
