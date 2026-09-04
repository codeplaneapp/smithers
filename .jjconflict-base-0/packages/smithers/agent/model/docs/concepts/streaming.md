---
title: "Streaming"
description: "How provider byte streams become ModelEvent values: framing, protocol state machines, settlement, and interruption."
sidebar:
  order: 2
---

Every built-in route asks its provider for a stream, and every consumer
reads the same `ModelEvent` vocabulary. This page explains the pipeline that
sits between the bytes and the events, and the two policies that keep an
interrupted stream honest.

## The pipeline

Four transformations happen between the socket and your code, each owned by
a piece of the route:

1. The transport answers a response whose body is a byte stream. A body that
   dies after the headers surfaces as a `transport` error on the stream.
2. The `Framing` turns bytes into frames. `sse` decodes UTF-8 Server-Sent
   Events across arbitrary chunk boundaries, discards empty frames, the
   `[DONE]` sentinel, and incomplete trailing frames, and ignores SSE retry
   directives, because reconnection is the executor's policy, not the
   framing's. `ndjson` yields one line per frame and deliberately surfaces a
   mid-line truncation as a frame the next stage will reject.
3. The protocol's event codec decodes each frame from JSON. A frame that
   fails decoding stops the stream as `invalid_provider_output` with a key
   path and no values.
4. The protocol's state machine folds each decoded event into zero or more
   `ModelEvent`s, carrying whatever the wire shape demands: Anthropic block
   indexes, Chat Completions tool-call array positions, Responses item ids.

When the upstream ends, the protocol's `onHalt` produces final events from
the last state. That hook is what closes parts the provider left open and
flushes unfinished tool calls, so a stream cut short still emits a coherent
suffix rather than dangling starts.

## Settlement is an event, not a return code

A model call settles exactly once, and the fact travels as data: the `settle`
event with its `stopReason`. Making settlement an event buys two things.
Consumers of a live stream see the ending in the same ordered sequence as
the content. And a fold over a recorded stream, days later in a replay,
derives the same answer from the same data.

The absence of the event is equally load-bearing: a stream without `settle`
was interrupted, by fiber cancellation or a dead transport.
`ModelEvent.settledMessage` encodes that as `stopReason: "aborted"` on the
folded message rather than throwing, because the partial turn is history a
transcript must record to stay resumable. The built-in lowerings then omit
an aborted or errored turn from the next request, since replaying a
provider-interrupted turn can make that request permanently invalid.

## Two policies for one condition

Tool-call argument text that is incomplete or malformed gets two different
treatments, and the split is deliberate:

- **Live streams are strict.** `ToolStream.end` completes a call only when
  the reassembled text is a JSON object; anything else fails the stream as
  `invalid_provider_output`. A live stream that cannot say what the model
  asked for must fail rather than execute a guess.
- **History is verbatim.** `ToolStream.flushAborted` and `settledMessage`
  preserve partial argument text exactly as it arrived. The journal's job is
  to record what happened, and laundering malformed output into `"{}"` would
  destroy the evidence.

The consequence for consumers: a `tool-call-end` observed on a built-in
protocol carries validated text, while a `ToolCallPart` inside an aborted
message carries whatever arrived. Validate arguments before executing either
way; the second case is why the rule exists.

## Usage is data too

Token counters arrive as `usage` events mid-stream, not as a side channel,
so run reports and the fold read the same numbers. Every counter is
optional, because providers disagree on which they expose: Anthropic reports
cache reads and writes, Chat Completions reports prompt and completion
totals, and a missing count is never a zero count. `settledMessage` merges
the events it sees, later counters overwriting earlier ones per field.

## Why a fold exists at all

Streaming is the right shape for rendering and for cancellation, but the
durable artifact of a turn is one assistant message: content parts, stop
reason, and the provider continuation state (`responseId`, `itemIds`,
thinking signatures) the next request must replay. `settledMessage` is the
single place that derives the artifact from the events, which keeps every
consumer's definition of "the turn that happened" identical. The events are
the source of truth; the message is their projection.

For the reading patterns, see [Read the stream](../guides/read-the-stream.md).
