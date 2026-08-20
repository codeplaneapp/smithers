import * as AgentEvent from "@flows/harness/AgentEvent";
import { HarnessError } from "@flows/harness/HarnessError";
import * as ModelRequest from "@flows/model/ModelRequest";
import { Cause, Effect, Queue, Stream } from "effect";

const emitsHarnessEvents = Symbol("emitsHarnessEvents");
const harnessInvocation = Symbol("harnessInvocation");

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return value == null ? "" : JSON.stringify(value);
};

const messageText = (message) => message.content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("");

const generateOptionsOf = (step, host, abortSignal) => {
  const system = [step.system, ...step.instructions]
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const options = {
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: step.prompt.text },
    ],
    abortSignal,
    harnessStep: step,
    harnessHost: host,
  };
  Object.defineProperty(options, harnessInvocation, {
    enumerable: true,
    value: Object.freeze({ step, host }),
  });
  return options;
};

/**
 * True only for options minted by the AgentLike-to-Harness bridge. Presence of
 * the public step/host fields alone is insufficient to authorize instruction
 * translation on legacy generate() calls.
 *
 * @param {unknown} options
 */
export const isValidatedHarnessInvocation = (options) => {
  if (!options || typeof options !== "object") return false;
  const invocation = options[harnessInvocation];
  return invocation !== undefined && invocation.step === options.harnessStep && invocation.host === options.harnessHost;
};

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
          const controller = new AbortController();
          let streamed = "";
          let resolved = false;
          const run = agent.generate({
            ...generateOptionsOf(step, host, controller.signal),
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
          }, (cause) => {
            if (controller.signal.aborted) return;
            Queue.failCauseUnsafe(queue, Cause.fail(new HarnessError({
              code: "unknown",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            })));
          });
          return { controller, run };
        }),
        ({ controller }) => Effect.sync(() => controller.abort(new DOMException("Harness stream interrupted", "AbortError"))),
      ));
    },
  };
};

/**
 * Native Harness entrypoint shared by first-class agents while generate()
 * remains available for legacy workflows.
 *
 * @param {import("./AgentLike.ts").AgentLike} agent
 * @param {import("@flows/harness/AgentStep").AgentStep} step
 * @param {import("@flows/harness/AgentStep").HostLike} host
 * @returns {ReturnType<import("@flows/harness/Harness").Harness["run"]>}
 */
export const runAgentLikeHarness = (agent, step, host) => agentLikeToHarness(agent).run(step, host);

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
