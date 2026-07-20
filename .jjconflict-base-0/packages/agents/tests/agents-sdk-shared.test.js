import { describe, expect, test } from "bun:test";
import { resolveSdkModel } from "../src/resolveSdkModel.js";
import { streamResultToGenerateResult } from "../src/streamResultToGenerateResult.js";
// ---------------------------------------------------------------------------
// resolveSdkModel — model factory pattern
// ---------------------------------------------------------------------------
describe("resolveSdkModel", () => {
    test("returns factory result when given a string", () => {
        const mockModel = { id: "test-model" };
        const result = resolveSdkModel("my-model-id", (id) => ({
            ...mockModel,
            resolvedFrom: id,
        }));
        expect(result.resolvedFrom).toBe("my-model-id");
        expect(result.id).toBe("test-model");
    });
    test("returns the model as-is when not a string", () => {
        const prebuiltModel = { id: "prebuilt", custom: true };
        const result = resolveSdkModel(prebuiltModel, () => {
            throw new Error("should not be called");
        });
        expect(result).toBe(prebuiltModel);
        expect(result.custom).toBe(true);
    });
    test("handles empty string as string input", () => {
        const result = resolveSdkModel("", (id) => ({ created: true, id }));
        expect(result.created).toBe(true);
        expect(result.id).toBe("");
    });
});
// ---------------------------------------------------------------------------
// streamResultToGenerateResult — stream → generate conversion
// ---------------------------------------------------------------------------
describe("streamResultToGenerateResult", () => {
    const usage = {
        inputTokens: 10,
        inputTokenDetails: {
            noCacheTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        },
        outputTokens: 5,
        outputTokenDetails: {
            textTokens: 5,
            reasoningTokens: 0,
        },
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        raw: undefined,
    };
    /**
   * @param {string[]} textParts
   */
    function createMockStream(textParts) {
        let consumed = false;
        return {
            fullStream: (async function* () {
                for (const text of textParts) {
                    yield { type: "text-delta", text };
                }
            })(),
            consumeStream: async () => {
                consumed = true;
            },
            content: Promise.resolve([{ type: "text", text: textParts.join("") }]),
            text: Promise.resolve(textParts.join("")),
            reasoning: Promise.resolve(undefined),
            reasoningText: Promise.resolve(undefined),
            files: Promise.resolve([]),
            sources: Promise.resolve([]),
            toolCalls: Promise.resolve([]),
            staticToolCalls: Promise.resolve([]),
            dynamicToolCalls: Promise.resolve([]),
            toolResults: Promise.resolve([]),
            staticToolResults: Promise.resolve([]),
            dynamicToolResults: Promise.resolve([]),
            finishReason: Promise.resolve("stop"),
            rawFinishReason: Promise.resolve("stop"),
            usage: Promise.resolve(usage),
            totalUsage: Promise.resolve(usage),
            warnings: Promise.resolve([]),
            steps: Promise.resolve([]),
            request: Promise.resolve({}),
            response: Promise.resolve({}),
            providerMetadata: Promise.resolve({}),
            output: Promise.resolve(undefined),
            get _consumed() { return consumed; },
        };
    }
    test("converts stream to generate result with stdout callback", async () => {
        const textParts = ["Hello", " ", "World"];
        const stream = createMockStream(textParts);
        const chunks = [];
        const result = await streamResultToGenerateResult(stream, (text) => chunks.push(text));
        expect(chunks).toEqual(["Hello", " ", "World"]);
        expect(result.text).toBe("Hello World");
        expect(result.finishReason).toBe("stop");
        expect(result.usage).toEqual(usage);
    });
    test("consumes stream without callback", async () => {
        const stream = createMockStream(["data"]);
        const result = await streamResultToGenerateResult(stream);
        expect(result.text).toBe("data");
        expect(result.finishReason).toBe("stop");
        // The stream should have been consumed via consumeStream()
        expect(stream._consumed).toBe(true);
    });
    test("preserves all result properties", async () => {
        const stream = createMockStream(["test"]);
        const result = await streamResultToGenerateResult(stream);
        expect(result.content).toBeDefined();
        expect(result.toolCalls).toEqual([]);
        expect(result.toolResults).toEqual([]);
        expect(result.steps).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.output).toBeUndefined();
    });
    // Regression: a provider 404 ("model not found") must surface as the real
    // AI_APICallError, not the SDK's masking NoOutputGeneratedError (which the
    // engine misreports as a structured-output JSON failure).
    function createErroringStream(withFullStreamError) {
        const apiError = Object.assign(new Error("model: gpt-nope not found"), {
            name: "AI_APICallError",
            statusCode: 404,
        });
        const masking = Object.assign(new Error("No output generated. Check the stream for errors."), { name: "AI_NoOutputGeneratedError" });
        return {
            fullStream: (async function* () {
                if (withFullStreamError)
                    yield { type: "error", error: apiError };
            })(),
            consumeStream: async (opts) => {
                opts?.onError?.(apiError);
            },
            content: Promise.reject(masking),
            text: Promise.reject(masking),
            reasoning: Promise.reject(masking),
            reasoningText: Promise.reject(masking),
            files: Promise.reject(masking),
            sources: Promise.reject(masking),
            toolCalls: Promise.reject(masking),
            staticToolCalls: Promise.reject(masking),
            dynamicToolCalls: Promise.reject(masking),
            toolResults: Promise.reject(masking),
            staticToolResults: Promise.reject(masking),
            dynamicToolResults: Promise.reject(masking),
            finishReason: Promise.reject(masking),
            rawFinishReason: Promise.reject(masking),
            usage: Promise.reject(masking),
            totalUsage: Promise.reject(masking),
            warnings: Promise.reject(masking),
            steps: Promise.reject(masking),
            request: Promise.reject(masking),
            response: Promise.reject(masking),
            providerMetadata: Promise.reject(masking),
            output: Promise.reject(masking),
        };
    }
    test("re-throws the provider error (stdout path) instead of the masking error", async () => {
        const stream = createErroringStream(true);
        let caught;
        try {
            await streamResultToGenerateResult(stream, () => {});
        } catch (err) {
            caught = err;
        }
        expect(caught?.name).toBe("AI_APICallError");
        expect(caught?.statusCode).toBe(404);
    });
    test("re-throws the provider error (no-callback path) instead of the masking error", async () => {
        const stream = createErroringStream(false);
        let caught;
        try {
            await streamResultToGenerateResult(stream);
        } catch (err) {
            caught = err;
        }
        expect(caught?.name).toBe("AI_APICallError");
        expect(caught?.statusCode).toBe(404);
    });
});
