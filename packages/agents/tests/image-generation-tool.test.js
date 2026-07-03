import { describe, expect, test } from "bun:test";
import { createImageGenerationTool } from "../src/index.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createImageGenerationTool", () => {
  test("creates an agent-callable image generation tool backed by a provider", async () => {
    const calls = [];
    const provider = {
      name: "test-image-provider",
      async generateImage(request) {
        calls.push(request);
        return {
          provider: "test-image-provider",
          model: request.model,
          images: [
            {
              mimeType: "image/png",
              base64: "iVBORw0KGgo=",
            },
          ],
        };
      },
    };

    const tool = createImageGenerationTool(provider, { model: "image-test-1" });

    expect(tool.description).toContain("Generate images");
    expect(typeof tool.execute).toBe("function");

    const result = await tool.execute(
      {
        prompt: "a quiet dashboard UI",
        size: "1024x1024",
        count: 1,
      },
      callOptions,
    );

    expect(calls).toEqual([
      {
        prompt: "a quiet dashboard UI",
        size: "1024x1024",
        count: 1,
        model: "image-test-1",
      },
    ]);
    expect(result).toEqual({
      provider: "test-image-provider",
      model: "image-test-1",
      images: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
    });
  });

  test("clamps count into the advertised 1..10 range before calling the provider", async () => {
    const calls = [];
    const provider = {
      async generateImage(request) {
        calls.push(request);
        return { images: [] };
      },
    };
    const tool = createImageGenerationTool(provider);

    await tool.execute({ prompt: "a", count: 50 }, callOptions);
    await tool.execute({ prompt: "b", count: 0 }, callOptions);
    await tool.execute({ prompt: "c", count: -3 }, callOptions);
    await tool.execute({ prompt: "d", count: 3.7 }, callOptions);
    await tool.execute({ prompt: "e", count: Number.POSITIVE_INFINITY }, callOptions);

    expect(calls.map((request) => request.count)).toEqual([10, 1, 1, 4, undefined]);
  });

  test("can return a named toolset for mounting on an agent", () => {
    const provider = {
      async generateImage() {
        return { images: [] };
      },
    };

    const toolset = createImageGenerationTool(provider, { asToolset: true });

    expect(Object.keys(toolset)).toEqual(["generate_image"]);
    expect(typeof toolset.generate_image.execute).toBe("function");
  });
});
