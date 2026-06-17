import { dynamicTool, jsonSchema } from "ai";

/** @typedef {import("ai").Tool} Tool */
/** @typedef {import("./ImageGenerationProvider.ts").ImageGenerationProvider} ImageGenerationProvider */
/** @typedef {import("./ImageGenerationToolOptions.ts").ImageGenerationToolOptions} ImageGenerationToolOptions */
/** @typedef {import("./ImageGenerationRequest.ts").ImageGenerationRequest} ImageGenerationRequest */

const DEFAULT_TOOL_NAME = "generate_image";

const imageGenerationInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      description: "A detailed description of the image to generate.",
      minLength: 1,
    },
    model: {
      type: "string",
      description: "Optional provider model override.",
    },
    size: {
      type: "string",
      description: "Requested output size, such as 1024x1024.",
    },
    count: {
      type: "integer",
      description: "Number of images to generate.",
      minimum: 1,
      maximum: 10,
    },
    seed: {
      type: "integer",
      description: "Optional deterministic seed when supported by the provider.",
    },
    style: {
      type: "string",
      description: "Optional provider-specific style hint.",
    },
  },
};

/**
 * Create an agent-callable image generation primitive backed by a provider.
 *
 * The provider boundary keeps Smithers independent of any single image model
 * vendor while still exposing a stable tool surface to AI SDK agents.
 *
 * @param {ImageGenerationProvider} provider
 * @param {ImageGenerationToolOptions} [options]
 * @returns {Tool | Record<string, Tool>}
 */
export function createImageGenerationTool(provider, options = {}) {
  if (!provider || typeof provider.generateImage !== "function") {
    throw new TypeError("createImageGenerationTool requires a provider with generateImage(request)");
  }

  const tool = dynamicTool({
    description:
      options.description ??
      "Generate images from a prompt. Returns image URLs or base64 image payloads from the configured provider.",
    inputSchema: jsonSchema(imageGenerationInputSchema),
    execute: async (input) => provider.generateImage(normalizeImageGenerationInput(input, options)),
  });

  if (options.asToolset) {
    return { [options.name ?? DEFAULT_TOOL_NAME]: tool };
  }
  return tool;
}

/**
 * @param {unknown} input
 * @param {ImageGenerationToolOptions} options
 * @returns {ImageGenerationRequest}
 */
function normalizeImageGenerationInput(input, options) {
  const value = /** @type {Partial<ImageGenerationRequest>} */ (input ?? {});
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
    throw new TypeError("generate_image requires a non-empty prompt");
  }
  return {
    prompt: value.prompt,
    ...(typeof value.size === "string" ? { size: value.size } : {}),
    ...(typeof value.count === "number" ? { count: value.count } : {}),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(typeof value.style === "string" ? { style: value.style } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : options.model ? { model: options.model } : {}),
  };
}
