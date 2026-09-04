---
title: "Fixtures and replay identity"
description: "How a recorded model call is identified: the canonical request encoding rather than a hash, what a recorder copies, which calls are never recorded, and how CachedModel and RecordedModel differ."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/fixtures.md"
---

A fixture is a portable recording of model calls. It is a JSON file with one
field, `calls`, and each call carries the request that was made, the model it
was recorded against, the events that came back, and the provider failure if
there was one.

Because a fixture is executable state, the rules around it are strict.

## Identity is the canonical encoding, not a hash

`Fixture.canonicalRequestDigest` sorts object keys recursively, retains array
order, and rejects anything that is not JSON with a typed
`FixtureEncodingError` naming the path of the offending value. It returns the
canonical **encoding** rather than a fixed-length hash.

The name is the one historical wart in the module, and the choice behind it is
deliberate. A cache selects the recorded call to replay by this value, and a
hash collision would replay another conversation's response as this one's. The
package owns no synchronous cryptographic hash, and a non-cryptographic one
buys shorter keys at the cost of a wrong answer nothing would detect.

The cost that made length matter, re-encoding every recorded call on every
lookup, is paid once per fixture instead. `Fixture.index` builds a digest-keyed
map and memoizes it on the fixture object, so a hundred-turn agent fixture
encodes its calls once rather than O(n squared) times per run.

The memo is keyed by object identity. `FixtureStore` replaces the whole fixture
on every append rather than mutating it, so a recorded call is visible to the
next lookup. A caller that instead mutates a fixture's `calls` in place would
read a stale index.

Strings are compared by code unit throughout, never by locale, and
`canonicalRequestDigest` rejects a value nested more than 128 levels deep
rather than overflowing the stack.

## A recorder copies, and copies at the right moment

`RecordingModel` projects the request when the stream is **acquired**, not
after the exchange ends, and snapshots each event as it is emitted.
`Fixture.recordedRequest` deep-copies every collection it stores, tool
`parameters`, `stopSequences`, `itemIds`, and `addedToolNames` included.

Both details answer the same failure. A caller that mutates its own request
while an exchange is in flight would otherwise have recorded a request the
provider never saw, and an event object the provider reused or the caller
mutated would change what the fixture recorded after the fact.

The projection also exists because the production `ModelRequest` is a
`Schema.Class` whose messages, tools, and params are class instances. A
recorder that stored one verbatim would write a fixture whose shape depends on
the class, and the digest rejects any value that is not a plain object. The
copy keeps the recorded request, the decoded fixture, and the digest input the
same value.

A fixture loaded through `Fixture.decode` is a plain value. Nothing in this
package mutates it, so holding one fixture across many replays is the intended
use.

## Two calls are never recorded

**An interrupted call, or one that died.** A truncated stream has no `settle`
event and would replay as an aborted turn, poisoning any cache built from the
same fixture. The recorder flushes on a settled stream and on a provider
failure, and stays silent otherwise.

**A call the kernel refused.** `PermissionRequired`, `PermissionDenied`, and
`GrantStoreError` are decisions made before the provider saw the request, so
there is no exchange to record. Replaying one would hand the code under test a
provider refusal the provider never made. The failure still reaches the caller
unchanged.

## Two doubles, two questions

`CachedModel` and `RecordedModel` both replay, and they answer different
questions.

|                         | `CachedModel`                                         | `RecordedModel`                              |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Matches on              | the whole canonical request, `modelId` included       | the request **shape**, with `modelId` erased |
| A call it does not have | runs against the live model and appends the recording | dies with `UnscriptedModelError`             |
| Reuse                   | serves one recording to every matching request        | claims each recorded call once               |
| Wrong model             | an ordinary miss, recorded as a second entry          | dies with `ReplayHarnessMismatchError`       |

Use `CachedModel` when a test only needs its calls to be free and
deterministic. Use `RecordedModel` when a test must assert that exactly the
recorded calls happened, which `RecordedModel.unconsumed()` reports.

The `model` field on a recorded call is the same value as `request.modelId`,
and decoding enforces that. It is stored separately because `RecordedModel`
matches by shape: once the shape has matched, `model` is what answers "was this
recorded against the model now asking?".

## The doubles die rather than fail

`UnscriptedModelError` and `ReplayHarnessMismatchError` are raised as defects,
not as typed failures, and they are deliberately absent from
`ModelLike.ModelLikeError`.

Both say the same thing: the fixture does not describe this run. That is a
defect in the test, not an outcome the code under test can handle, and neither
is a member of the production `ModelFailure` union. A replay model that failed
with one could not be adapted to the production seam without laundering it into
a provider code, and code that retries or falls back on provider failures would
then retry against a fixture that will never match. The test would pass or hang
for the wrong reason.

A defect cannot be caught by `Effect.catchTag` or a retry schedule, and it
fails the test at the call that has no recording. That is the intended
behavior.

## The package reads no environment

`CachedModel` records whatever the fixture is missing, so how a consumer
decides to record is the consumer's business: an environment flag such as
`SMTHRS_RECORD=1` that swaps the live model for one with no credentials, a
separate `test:record` script, or deleting the fixture file and re-running.
This package has no opinion and reads no environment variable.

[Replay a model instead of calling one](/guides/replay-a-model/) builds the
loop end to end.
