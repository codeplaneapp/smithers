import { describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SandboxEntityExecutor } from "../src/effect/sandbox-entity.js";
import {
    CodeplaneSandboxExecutorLive,
    DockerSandboxExecutorLive,
} from "../src/effect/http-runner.js";
import { BubblewrapSandboxExecutorLive } from "../src/effect/socket-runner.js";
import { layerForSandboxRuntime, resolveSandboxRuntime } from "../src/transport.js";
import { bubblewrapArgs, dockerArgs, sandboxExecArgs } from "../src/effect/process-runner.js";

/**
 * @param {string} prefix
 */
function tempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @template A
 * @param {import("effect").Layer.Layer<SandboxEntityExecutor, unknown, unknown>} layer
 * @param {(executor: import("../src/SandboxTransportService.ts").SandboxTransportService) => import("effect").Effect.Effect<A, unknown, unknown>} effect
 */
async function runExecutor(layer, effect) {
    return Effect.runPromise(
        Effect.flatMap(SandboxEntityExecutor, (executor) => effect(executor)).pipe(
            Effect.provide(layer),
        ),
    );
}

/**
 * @param {Record<string, string | undefined>} patch
 * @param {() => Promise<void>} fn
 */
async function withEnv(patch, fn) {
    const previous = {};
    for (const key of Object.keys(patch)) {
        previous[key] = process.env[key];
        if (patch[key] === undefined) {
            delete process.env[key];
        }
        else {
            process.env[key] = patch[key];
        }
    }
    try {
        await fn();
    }
    finally {
        for (const key of Object.keys(patch)) {
            if (previous[key] === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = previous[key];
            }
        }
    }
}

/**
 * @param {NodeJS.Platform} platform
 * @param {() => Promise<void>} fn
 */
async function withPlatform(platform, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
        await fn();
    }
    finally {
        if (descriptor) {
            Object.defineProperty(process, "platform", descriptor);
        }
    }
}

/**
 * @param {(command: string) => string | null} implementation
 * @param {() => Promise<void>} fn
 */
async function withBunWhich(implementation, fn) {
    const original = Bun.which;
    Bun.which = implementation;
    try {
        await fn();
    }
    finally {
        Bun.which = original;
    }
}

/**
 * @param {string} rootDir
 * @param {string} runId
 * @param {string} sandboxId
 * @param {"bubblewrap" | "docker" | "codeplane"} runtime
 */
function configFor(rootDir, runId, sandboxId, runtime) {
    return { runId, sandboxId, runtime, rootDir };
}

/**
 * @param {string} label
 */
function makeBundle(label) {
    const bundlePath = tempDir(`smithers-${label}-bundle-`);
    writeFileSync(join(bundlePath, "README.md"), `bundle:${label}`, "utf8");
    mkdirSync(join(bundlePath, "nested"), { recursive: true });
    writeFileSync(join(bundlePath, "nested", "file.txt"), "payload", "utf8");
    return bundlePath;
}

/**
 * @param {import("effect").Layer.Layer<SandboxEntityExecutor, unknown, unknown>} layer
 * @param {ReturnType<typeof configFor>} config
 */
async function expectExecutorLifecycle(layer, config) {
    const bundlePath = makeBundle(config.runtime);
    const handle = await runExecutor(layer, (executor) => executor.create(config));
    expect(handle).toMatchObject({
        runtime: config.runtime,
        runId: config.runId,
        sandboxId: config.sandboxId,
        sandboxRoot: join(config.rootDir, ".smithers", "sandboxes", config.runId, config.sandboxId),
    });
    expect(existsSync(handle.requestPath)).toBe(true);
    expect(existsSync(handle.resultPath)).toBe(true);

    await runExecutor(layer, (executor) => executor.ship(bundlePath, handle));
    expect(readFileSync(join(handle.requestPath, "README.md"), "utf8")).toBe(`bundle:${config.runtime}`);
    expect(readFileSync(join(handle.requestPath, "nested", "file.txt"), "utf8")).toBe("payload");
    expect(await runExecutor(layer, (executor) => executor.execute("smithers up bundle.tsx", handle))).toEqual({
        exitCode: 0,
    });
    expect(await runExecutor(layer, (executor) => executor.collect(handle))).toEqual({
        bundlePath: handle.resultPath,
    });
    await expect(runExecutor(layer, (executor) => executor.cleanup(handle))).resolves.toBeUndefined();
    return handle;
}

function makeFakeDockerBin() {
    return makeFakeBin("docker", "#!/bin/sh\nexit 0\n");
}

/**
 * @param {string} name
 * @param {string} script
 */
function makeFakeBin(name, script = "#!/bin/sh\nexit 0\n") {
    const binDir = tempDir("smithers-fake-docker-bin-");
    const binPath = join(binDir, name);
    writeFileSync(binPath, script, "utf8");
    chmodSync(binPath, 0o755);
    return { binDir, binPath };
}

describe("sandbox transport runners", () => {
    test("bubblewrap executor creates, ships, executes, collects, and cleans up", async () => {
        const fake = makeFakeBin("bwrap");
        await withPlatform("linux", () =>
            withBunWhich((command) => (command === "bwrap" ? fake.binPath : null), async () => {
                await expectExecutorLifecycle(
                    BubblewrapSandboxExecutorLive,
                    configFor(tempDir("smithers-bubblewrap-"), "run-bwrap", "sandbox-bwrap", "bubblewrap"),
                );
            }),
        );
    });

    test("bubblewrap executor reports the missing Linux binary", async () => {
        await withPlatform("linux", () =>
            withBunWhich(() => null, async () => {
                await expect(
                    runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                        executor.create(
                            configFor(tempDir("smithers-bubblewrap-"), "run-no-bwrap", "sandbox", "bubblewrap"),
                        ),
                    ),
                ).rejects.toThrow("bwrap");
            }),
        );
    });

    test("bubblewrap executor reports the missing macOS fallback binary", async () => {
        await withPlatform("darwin", () =>
            withBunWhich(() => null, async () => {
                await expect(
                    runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                        executor.create(
                            configFor(tempDir("smithers-bubblewrap-"), "run-no-sandbox-exec", "sandbox", "bubblewrap"),
                        ),
                    ),
                ).rejects.toThrow("sandbox-exec");
            }),
        );
    });

    test("bubblewrap executor accepts the macOS fallback binary", async () => {
        const fake = makeFakeBin("sandbox-exec");
        await withPlatform("darwin", () =>
            withBunWhich((command) => (command === "sandbox-exec" ? fake.binPath : null), async () => {
                const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                    executor.create(
                        configFor(tempDir("smithers-bubblewrap-"), "run-sandbox-exec", "sandbox", "bubblewrap"),
                    ),
                );
                expect(handle.runtime).toBe("bubblewrap");
                expect(existsSync(handle.requestPath)).toBe(true);
                expect(existsSync(handle.resultPath)).toBe(true);
            }),
        );
    });

    test("docker executor uses docker info before creating the workspace", async () => {
        const fakeDocker = makeFakeDockerBin();
        await withEnv({ PATH: `${fakeDocker.binDir}:${process.env.PATH ?? ""}` }, async () => {
            await expectExecutorLifecycle(
                DockerSandboxExecutorLive,
                configFor(tempDir("smithers-docker-"), "run-docker", "sandbox-docker", "docker"),
            );
        });
    });

    test("docker executor reports an unreachable daemon", async () => {
        await withEnv({ PATH: tempDir("smithers-empty-path-") }, async () => {
            await expect(
                runExecutor(DockerSandboxExecutorLive, (executor) =>
                    executor.create(configFor(tempDir("smithers-docker-"), "run-docker-fail", "sandbox", "docker")),
                ),
            ).rejects.toThrow("Docker daemon not reachable");
        });
    });

    test("codeplane executor validates required environment", async () => {
        await withEnv({ CODEPLANE_API_URL: undefined, CODEPLANE_API_KEY: undefined }, async () => {
            await expect(
                runExecutor(CodeplaneSandboxExecutorLive, (executor) =>
                    executor.create(
                        configFor(tempDir("smithers-codeplane-"), "run-codeplane-fail", "sandbox", "codeplane"),
                    ),
                ),
            ).rejects.toThrow("requires CODEPLANE_API_URL and CODEPLANE_API_KEY");
        });
    });

    test("runtime selection covers all transport layer branches", async () => {
        expect(layerForSandboxRuntime("docker")).toBeDefined();
        expect(layerForSandboxRuntime("codeplane")).toBeDefined();
        expect(layerForSandboxRuntime("bubblewrap")).toBeDefined();
        expect(layerForSandboxRuntime("unknown-runtime")).toBeDefined();

        await withBunWhich((command) => (command === "docker" ? "/usr/bin/docker" : null), async () => {
            expect(resolveSandboxRuntime("docker")).toBe("docker");
        });
        await withBunWhich(() => null, async () => {
            expect(resolveSandboxRuntime("docker")).toBe("bubblewrap");
            expect(resolveSandboxRuntime("codeplane")).toBe("codeplane");
        });
    });

    test("local sandbox command args enforce network defaults and mount request/result paths", () => {
        const handle = {
            runtime: "docker",
            runId: "run",
            sandboxId: "sandbox",
            sandboxRoot: "/tmp/sandbox",
            requestPath: "/tmp/sandbox/request",
            resultPath: "/tmp/sandbox/result",
            image: "node:22-slim",
            allowNetwork: false,
        };

        expect(dockerArgs("npm test", handle)).toContain("--network");
        expect(dockerArgs("npm test", handle)).toContain("none");
        expect(dockerArgs("npm test", { ...handle, allowNetwork: true })).not.toContain("--network");

        const bwrap = bubblewrapArgs("npm test", handle);
        expect(bwrap).toContain("--unshare-net");
        expect(bwrap).toContain("/workspace");
        expect(bwrap).toContain("/result");

        const sandboxExec = sandboxExecArgs("npm test", handle).join(" ");
        expect(sandboxExec).toContain("(deny network*)");
        expect(sandboxExec).toContain(handle.requestPath);
        expect(sandboxExec).toContain(handle.resultPath);
    });

    test("sandbox-exec profile escapes mounted paths", () => {
        const handle = {
            runtime: "bubblewrap",
            runId: "run",
            sandboxId: "sandbox",
            sandboxRoot: "/tmp/sandbox",
            requestPath: '/tmp/sandbox/request"quoted',
            resultPath: "/tmp/sandbox/result\\slash",
            allowNetwork: false,
        };

        const profile = sandboxExecArgs("npm test", handle)[1];
        expect(profile).toContain('/tmp/sandbox/request\\"quoted');
        expect(profile).toContain("/tmp/sandbox/result\\\\slash");
    });
});
