import { describe, expect, test } from "bun:test";
import { ElizaAgent } from "../src/ElizaAgent.js";
import { z } from "zod";

/** Minimal character for tests. */
const testCharacter = { name: "TestBot", bio: "A test bot" };

/**
 * Minimal fake runtime that records constructor calls and returns canned text.
 */
function createFakeRuntime(responseText = "hello from eliza") {
    const calls: { modelType: string; prompt: string; abortSignal?: AbortSignal }[] = [];
    let initCount = 0;
    let stopCount = 0;

    const runtime = {
        async initialize() {
            initCount++;
        },
        async useModel(modelType: string, params: { prompt: string; abortSignal?: AbortSignal }) {
            calls.push({
                modelType,
                prompt: params.prompt,
                abortSignal: params.abortSignal,
            });
            return responseText;
        },
        async stop() {
            stopCount++;
        },
        getCalls() {
            return calls;
        },
        getInitCount() {
            return initCount;
        },
        getStopCount() {
            return stopCount;
        },
    };
    return runtime;
}

/**
 * Helper that wires a fake runtime factory into ElizaAgent.
 */
function createAgentWithFakeRuntime(
    opts: ConstructorParameters<typeof ElizaAgent>[0] = { character: testCharacter },
    responseText = "hello from eliza"
) {
    const fake = createFakeRuntime(responseText);
    const agent = new ElizaAgent(opts, {
        runtimeFactory: async () => fake as any,
    });
    return { agent, fake };
}

describe("ElizaAgent", () => {
    describe("preflight()", () => {
        test("rejects with actionable message when @elizaos/core cannot be resolved", async () => {
            const agent = new ElizaAgent(
                { character: testCharacter },
                {
                    runtimeFactory: async () => {
                        throw new Error(
                            "install @elizaos/core to use ElizaAgent: npm install @elizaos/core"
                        );
                    },
                }
            );
            await expect(agent.preflight()).rejects.toThrow(
                /install @elizaos\/core to use ElizaAgent/
            );
        });

        test("rejects when character.name is missing", async () => {
            const agent = new ElizaAgent(
                // @ts-expect-error intentionally invalid
                { character: {} },
                { runtimeFactory: async () => createFakeRuntime() as any }
            );
            await expect(agent.preflight()).rejects.toThrow(
                /character\.name is required/
            );
        });

        test("resolves when runtime factory succeeds", async () => {
            const { agent } = createAgentWithFakeRuntime();
            await expect(agent.preflight()).resolves.toBeUndefined();
        });

        test("initializes the runtime exactly once during preflight", async () => {
            const { agent, fake } = createAgentWithFakeRuntime();
            await agent.preflight();
            await agent.preflight();
            expect(fake.getInitCount()).toBe(1);
        });
    });

    describe("option pass-through", () => {
        test("plugins are forwarded to the runtime factory", async () => {
            const receivedPlugins: unknown[] = [];
            const plugin = { name: "test-plugin" };
            const agent = new ElizaAgent(
                { character: testCharacter, plugins: [plugin] },
                {
                    runtimeFactory: async (opts) => {
                        receivedPlugins.push(...(opts.plugins ?? []));
                        return createFakeRuntime() as any;
                    },
                }
            );
            await agent.preflight();
            expect(receivedPlugins).toContain(plugin);
        });

        test("settings are forwarded to the runtime factory", async () => {
            let receivedSettings: Record<string, string> | undefined;
            const agent = new ElizaAgent(
                { character: testCharacter, settings: { SLACK_BOT_TOKEN: "xoxb-fake" } },
                {
                    runtimeFactory: async (opts) => {
                        receivedSettings = opts.settings;
                        return createFakeRuntime() as any;
                    },
                }
            );
            await agent.preflight();
            expect(receivedSettings).toMatchObject({ SLACK_BOT_TOKEN: "xoxb-fake" });
        });

        test("env is forwarded to the runtime factory", async () => {
            let receivedEnv: Record<string, string> | undefined;
            const agent = new ElizaAgent(
                { character: testCharacter, env: { DISCORD_TOKEN: "disc-fake" } },
                {
                    runtimeFactory: async (opts) => {
                        receivedEnv = opts.env;
                        return createFakeRuntime() as any;
                    },
                }
            );
            await agent.preflight();
            expect(receivedEnv).toMatchObject({ DISCORD_TOKEN: "disc-fake" });
        });

        test("character is forwarded to the runtime factory", async () => {
            const character = { name: "MyBot", bio: "Custom bio" };
            let receivedCharacter: unknown;
            const agent = new ElizaAgent(
                { character },
                {
                    runtimeFactory: async (opts) => {
                        receivedCharacter = opts.character;
                        return createFakeRuntime() as any;
                    },
                }
            );
            await agent.preflight();
            expect((receivedCharacter as typeof character).name).toBe("MyBot");
        });
    });

    describe("generate()", () => {
        test("returns text from the runtime", async () => {
            const { agent } = createAgentWithFakeRuntime(
                { character: testCharacter },
                "runtime response text"
            );
            const result = await agent.generate({ prompt: "test prompt" });
            expect(result.text).toBe("runtime response text");
        });

        test("passes the prompt through to useModel", async () => {
            const { agent, fake } = createAgentWithFakeRuntime();
            await agent.generate({ prompt: "my prompt" });
            expect(fake.getCalls()[0]?.prompt).toBe("my prompt");
        });

        test("result has the expected GenerateTextResult shape", async () => {
            const { agent } = createAgentWithFakeRuntime();
            const result = await agent.generate({ prompt: "shape check" });
            expect(result).toMatchObject({
                text: expect.any(String),
                finishReason: "stop",
                content: expect.arrayContaining([
                    expect.objectContaining({ type: "text" }),
                ]),
                response: expect.objectContaining({
                    modelId: "eliza",
                }),
            });
        });

        test("uses modelId option in result", async () => {
            const { agent } = createAgentWithFakeRuntime({ character: testCharacter, modelId: "my-eliza-model" });
            const result = await agent.generate({ prompt: "check modelId" });
            expect((result as any).response.modelId).toBe("my-eliza-model");
        });

        test("streams text to onStdout", async () => {
            const { agent } = createAgentWithFakeRuntime(
                { character: testCharacter },
                "streamed text"
            );
            const chunks: string[] = [];
            await agent.generate({
                prompt: "stream this",
                onStdout: (t) => chunks.push(t),
            });
            expect(chunks.join("")).toBe("streamed text");
        });

        test("with outputSchema: parses JSON text into output", async () => {
            const { agent } = createAgentWithFakeRuntime(
                { character: testCharacter },
                JSON.stringify({ count: 42 })
            );
            const schema = z.object({ count: z.number() });
            const result = await agent.generate({
                prompt: "return json",
                outputSchema: schema,
            });
            expect(result.text).toBe(JSON.stringify({ count: 42 }));
            expect((result as any).output).toMatchObject({ count: 42 });
            expect((result as any).output).toMatchObject({ count: 42 });
        });

        test("with outputSchema: throws when text is not valid JSON", async () => {
            const { agent } = createAgentWithFakeRuntime(
                { character: testCharacter },
                "plain text response"
            );
            const schema = z.object({ count: z.number() });
            await expect(
                agent.generate({ prompt: "this won't parse", outputSchema: schema })
            ).rejects.toThrow();
        });

        test("reuses the same runtime across multiple generate calls", async () => {
            const { agent, fake } = createAgentWithFakeRuntime();
            await agent.generate({ prompt: "first" });
            await agent.generate({ prompt: "second" });
            expect(fake.getInitCount()).toBe(1);
        });

        test("rejects when abortSignal is already aborted before call", async () => {
            const { agent } = createAgentWithFakeRuntime();
            const controller = new AbortController();
            controller.abort();
            await expect(
                agent.generate({ prompt: "aborted", abortSignal: controller.signal })
            ).rejects.toThrow(/aborted/);
        });

        test("passes abortSignal through to useModel", async () => {
            const { agent, fake } = createAgentWithFakeRuntime();
            const controller = new AbortController();
            await agent.generate({
                prompt: "signal please",
                abortSignal: controller.signal,
            });
            expect(fake.getCalls()[0]?.abortSignal).toBe(controller.signal);
        });

        test("rejects promptly when abortSignal fires during useModel", async () => {
            let markModelCalled!: () => void;
            const modelCalled = new Promise<void>((resolve) => {
                markModelCalled = resolve;
            });
            const fake = {
                async initialize() {},
                async useModel(
                    _modelType: string,
                    _params: { prompt: string; abortSignal?: AbortSignal }
                ) {
                    markModelCalled();
                    return new Promise<string>(() => {});
                },
                async stop() {},
            };
            const agent = new ElizaAgent(
                { character: testCharacter },
                { runtimeFactory: async () => fake as any }
            );
            const controller = new AbortController();
            const generation = agent.generate({
                prompt: "abort mid-call",
                abortSignal: controller.signal,
            });

            await modelCalled;
            controller.abort();

            await expect(generation).rejects.toThrow(/aborted/);
        });
    });

    describe("supportsNativeStructuredOutput", () => {
        test("is false", () => {
            const { agent } = createAgentWithFakeRuntime();
            expect(agent.supportsNativeStructuredOutput).toBe(false);
        });
    });

    describe("stop()", () => {
        test("calls runtime.stop()", async () => {
            const { agent, fake } = createAgentWithFakeRuntime();
            await agent.generate({ prompt: "init runtime" });
            await agent.stop();
            expect(fake.getStopCount()).toBe(1);
        });

        test("safe to call before runtime is initialized", async () => {
            const { agent } = createAgentWithFakeRuntime();
            await expect(agent.stop()).resolves.toBeUndefined();
        });

        test("stop() during initialization properly cleans up the runtime", async () => {
            let resolveInit!: () => void;
            const initBlocker = new Promise<void>((resolve) => {
                resolveInit = resolve;
            });

            const stopCalls: number[] = [];
            const fake = {
                initCount: 0,
                async initialize() {
                    await initBlocker;
                    this.initCount++;
                },
                async useModel(_type: string, _params: { prompt: string }) {
                    return "text";
                },
                async stop() {
                    stopCalls.push(1);
                },
            };

            const agent = new ElizaAgent(
                { character: testCharacter },
                { runtimeFactory: async () => fake as any }
            );

            // Start initialization (it will block on initBlocker).
            const preflightPromise = agent.preflight().catch(() => {});

            // Stop while init is still in flight.
            const stopPromise = agent.stop();

            // Unblock the factory so init can complete.
            resolveInit();

            await stopPromise;
            await preflightPromise;

            // The runtime's stop() must have been called to release resources.
            expect(stopCalls.length).toBe(1);
        });
    });
});
