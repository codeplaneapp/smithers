import * as OpenAICompatible from "@flows/model/OpenAICompatible";
import * as RequestExecutor from "@flows/model/RequestExecutor";
import * as Route from "@flows/model/Route";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Effect, Redacted, Result } from "effect";

/** @param {string} baseUrl */
const normalizeOpenAICompatibleBaseUrl = (baseUrl) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.toLowerCase().endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
  return url.toString();
};

/**
 * Build the provider-backed flows Model once the caller is inside an Effect
 * fiber. Interrupting that fiber therefore interrupts both route setup and the
 * HTTP stream owned by RequestExecutor.
 * @param {Record<string, any>} options
 * @param {"anthropic" | "openai"} family
 */
export const resolveProviderModel = (options, family) => {
  if (typeof options.model !== "string") return Effect.succeed(options.model);
  return Effect.suspend(() => {
    const envKey = family === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    const apiKey = Redacted.make(options.apiKey ?? envKey ?? "");
    const routeResult =
      family === "anthropic"
        ? Route.anthropic({ apiKey })
        : options.baseURL
          ? OpenAICompatible.make({
              id: "openai-compatible",
              baseUrl: normalizeOpenAICompatibleBaseUrl(options.baseURL),
              apiKey,
            })
          : Route.openai({ apiKey });
    return Route.toModel(Result.getOrThrow(routeResult)).pipe(
      Effect.provide(RequestExecutor.layer),
      Effect.provide(NodeHttpClient.layerFetch),
    );
  });
};
