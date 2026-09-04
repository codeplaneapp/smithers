import { describe, expect, test } from "bun:test";
import { AgentEvent } from "@smthrs/harness";
import { ModelRequest } from "@smthrs/model";
import * as EventSink from "@smthrs/agent/EventSink";
import { Effect } from "effect";
import { createProgressReporter } from "../../src/cli/createProgressReporter.ts";

const params = { temperature: undefined, topP: undefined, maxOutputTokens: undefined } as never;

const assistantMessage = new ModelRequest.AssistantMessage({
  role: "assistant",
  content: [],
  stopReason: "stop",
});

function sink(reporter: ReturnType<typeof createProgressReporter>) {
  return (event: AgentEvent.AgentEvent) =>
    Effect.runSync(
      EventSink.EventSink.pipe(
        Effect.flatMap((service) => service.emit(event)),
        Effect.provide(reporter.layer),
      ),
    );
}

function turnOpened(seat: string) {
  return new AgentEvent.TurnOpened({
    eventType: "flows.harness.turn-opened.v1",
    seat,
    modelParams: params,
    activeToolNames: [],
    contextDigest: "digest",
  });
}

describe("createProgressReporter", () => {
  test("numbers each seat's turns independently", () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({ write: (line) => lines.push(line) });
    const emit = sink(reporter);

    emit(turnOpened("review"));
    emit(turnOpened("review"));
    emit(turnOpened("review-narrate"));

    expect(lines).toEqual(["review: turn 1", "review: turn 2", "review-narrate: turn 1"]);
    expect([...reporter.turns()]).toEqual([
      ["review", 2],
      ["review-narrate", 1],
    ]);
  });

  test("accumulates settled usage without printing a line per settlement", () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({ write: (line) => lines.push(line) });
    const emit = sink(reporter);

    emit(
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: assistantMessage,
        usage: { inputTokens: 100, outputTokens: 20 },
        durationMillis: 12,
      }),
    );
    emit(
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: assistantMessage,
        usage: { inputTokens: 5 },
        durationMillis: 3,
      }),
    );

    expect(lines).toEqual([]);
    expect(reporter.tokens()).toEqual({ input: 105, output: 20 });
  });

  test("names a retry by attempt and code, and an abort by reason", () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({ write: (line) => lines.push(line) });
    const emit = sink(reporter);

    emit(
      new AgentEvent.ModelRetried({
        eventType: "flows.harness.model-retried.v1",
        attempt: 2,
        code: "transport",
        delayMillis: 500,
      }),
    );
    emit(new AgentEvent.Aborted({ eventType: "flows.harness.aborted.v1", reason: "budget exhausted" }));

    expect(lines).toEqual([
      "retrying the model call (attempt 2): transport",
      "aborted: budget exhausted",
    ]);
  });

  test("stays silent for events it does not report", () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({ write: (line) => lines.push(line) });
    const emit = sink(reporter);

    emit(
      new AgentEvent.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "stop",
        outcome: "resolved",
      }),
    );

    expect(lines).toEqual([]);
    expect(reporter.tokens()).toEqual({ input: 0, output: 0 });
  });
});
