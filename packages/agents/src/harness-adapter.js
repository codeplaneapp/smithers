import * as AgentEvent from "@flows/harness/AgentEvent";
import { HarnessError } from "@flows/harness/HarnessError";
import * as ModelRequest from "@flows/model/ModelRequest";
import { Effect, Queue, Stream } from "effect";

const emitsHarnessEvents = Symbol("emitsHarnessEvents");

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return value == null ? "" : JSON.stringify(value);
};

const messageText = (message) => message.content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("");

/**
 * Adapt the legacy Smithers AgentLike contract to the flows Harness contract.
 * Native harness events delivered through onEvent are retained byte-for-byte;
 * plain legacy agents are projected to model deltas plus a resolved message.
 *
 * @param {import("./AgentLike.ts").AgentLike} agent
 * @returns {import("@flows/harness/Harness").Harness}
 */
export const agentLikeToHarness = (agent) => {
  const nativeEvents = agent[emitsHarnessEvents] === true;
  return {
    run(step, host) {
      return Stream.callback((queue) => Effect.acquireRelease(
        Effect.sync(() => {
          let streamed = "";
          let resolved = false;
          const run = agent.generate({
            prompt: step.prompt.text,
            harnessStep: step,
            harnessHost: host,
            onStdout(text) {
              streamed += text;
              if (!nativeEvents) Queue.offerUnsafe(queue, new AgentEvent.ModelDelta({
                eventType: "flows.harness.model-delta.v1",
                delta: { type: "text-delta", id: "legacy", text },
              }));
            },
            onEvent(value) {
              if (value.type === "harness-event") {
                resolved ||= value.event._tag === "resolved";
                Queue.offerUnsafe(queue, value.event);
              }
            },
          }).then((result) => {
            if (!resolved) Queue.offerUnsafe(queue, new AgentEvent.Resolved({
              eventType: "flows.harness.resolved.v1",
              message: ModelRequest.Message.assistant(textOf(result) || streamed),
            }));
            Queue.endUnsafe(queue);
          }, (cause) => Queue.failUnsafe(queue, new HarnessError({
            code: "unknown",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          })));
          return run;
        }),
        () => Effect.void,
      ));
    },
  };
};

/**
 * Adapt a flows Harness for legacy workflow code expecting AgentLike.generate.
 * The caller supplies harnessStep/harnessHost because both are part of the new
 * contract and intentionally cannot be reconstructed from a prompt string.
 *
 * @param {import("@flows/harness/Harness").Harness} harness
 * @returns {import("./AgentLike.ts").AgentLike}
 */
export const harnessToAgentLike = (harness) => {
  return {
    [emitsHarnessEvents]: true,
    async generate(options = {}) {
      if (!options.harnessStep || !options.harnessHost) {
        throw new TypeError("A harness-backed AgentLike requires harnessStep and harnessHost");
      }
      const events = [];
      await Effect.runPromise(Stream.runForEach(
        harness.run(options.harnessStep, options.harnessHost),
        (event) => Effect.promise(async () => {
          events.push(event);
          await options.onEvent?.({ type: "harness-event", event });
          if (event._tag === "model-delta" && event.delta.type === "text-delta") options.onStdout?.(event.delta.text);
        }),
      ));
      const resolved = events.findLast((event) => event._tag === "resolved");
      const text = resolved ? messageText(resolved.message) : "";
      return { text, output: resolved?.message, events };
    },
  };
};
