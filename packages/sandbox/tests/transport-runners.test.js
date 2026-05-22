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
    const executeCommand = config.runtime === "bubblewrap"
        ? "printf ok > ../result/executed.txt"
        : "smithers up bundle.tsx";
    expect(await runExecutor(layer, (executor) => executor.execute(executeCommand, handle))).toEqual({
        exitCode: 0,
    });
    if (config.runtime === "bubblewrap") {
        expect(readFileSync(join(handle.resultPath, "executed.txt"), "utf8")).toBe("ok");
    }
    expect(await runExecutor(layer, (executor) => executor.collect(handle))).toEqual({
        bundlePath: handle.resultPath,
    });
    await expect(runExecutor(layer, (executor) => executor.cleanup(handle))).resolves.toBeUndefined();
    if (config.runtime === "bubblewrap") {
        expect(existsSync(handle.sandboxRoot)).toBe(false);
    }
    return handle;
}

function makeFakeDockerBin() {
    const binDir = tempDir("smithers-fake-docker-bin-");
    const dockerPath = join(binDir, "docker");
    writeFileSync(dockerPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(dockerPath, 0o755);
    return binDir;
}

function makeFakeBwrapBin() {
    const binDir = tempDir("smithers-fake-bwrap-bin-");
    const bwrapPath = join(binDir, "bwrap");
    writeFileSync(
        bwrapPath,
        [
            "#!/bin/sh",
            "last=''",
            "for arg in \"$@\"; do",
            "  last=\"$arg\"",
            "done",
            "/bin/sh -lc \"$last\"",
            "",
        ].join("\n"),
        "utf8",
    );
    chmodSync(bwrapPath, 0o755);
    return bwrapPath;
}

/**
 * @param {string} captureDir
 */
function makeFakeSandboxExecBin(captureDir) {
    const binDir = tempDir("smithers-fake-sandbox-exec-bin-");
    const sandboxExecPath = join(binDir, "sandbox-exec");
    writeFileSync(
        sandboxExecPath,
        [
            "#!/bin/sh",
            `printf '%s\\n' "$@" > ${JSON.stringify(join(captureDir, "args.txt"))}`,
            `printf '%s\\n' "$HOME" > ${JSON.stringify(join(captureDir, "home.txt"))}`,
            `printf '%s\\n' "$TMPDIR" > ${JSON.stringify(join(captureDir, "tmpdir.txt"))}`,
            "last=''",
            "for arg in \"$@\"; do",
            "  last=\"$arg\"",
            "done",
            "/bin/sh -lc \"$last\"",
            "",
        ].join("\n"),
        "utf8",
    );
    chmodSync(sandboxExecPath, 0o755);
    return sandboxExecPath;
}

describe("sandbox transport runners", () => {
    test("bubblewrap executor creates, ships, executes, collects, and cleans up", async () => {
        const fakeBwrap = makeFakeBwrapBin();
        await withPlatform("linux", () =>
            withBunWhich((command) => (command === "bwrap" ? fakeBwrap : null), async () => {
                await expectExecutorLifecycle(
                    BubblewrapSandboxExecutorLive,
                    configFor(tempDir("smithers-bubblewrap-"), "run-bwrap", "sandbox-bwrap", "bubblewrap"),
                );
            }),
        );
    });

    test("bubblewrap executor does not inherit host secrets", async () => {
        const fakeBwrap = makeFakeBwrapBin();
        await withEnv({ SMITHERS_SECRET_SHOULD_NOT_LEAK: "secret" }, () =>
            withPlatform("linux", () =>
                withBunWhich((command) => (command === "bwrap" ? fakeBwrap : null), async () => {
                    const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                        executor.create(
                            configFor(tempDir("smithers-bubblewrap-"), "run-bwrap-env", "sandbox", "bubblewrap"),
                        ),
                    );
                    try {
                        await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                            executor.execute(
                                'test -z "$SMITHERS_SECRET_SHOULD_NOT_LEAK" && printf ok > ../result/env.txt',
                                handle,
                            ),
                        );
                        expect(readFileSync(join(handle.resultPath, "env.txt"), "utf8")).toBe("ok");
                    } finally {
                        await runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.cleanup(handle));
                    }
                    expect(existsSync(handle.sandboxRoot)).toBe(false);
                }),
            ),
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

    test("bubblewrap executor fails when the sandboxed command fails", async () => {
        const fakeBwrap = makeFakeBwrapBin();
        await withPlatform("linux", () =>
            withBunWhich((command) => (command === "bwrap" ? fakeBwrap : null), async () => {
                const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                    executor.create(configFor(tempDir("smithers-bubblewrap-"), "run-bwrap-fail", "sandbox", "bubblewrap")),
                );
                try {
                    await expect(
                        runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.execute("exit 7", handle)),
                    ).rejects.toThrow("Sandbox command exited with code 7");
                } finally {
                    await runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.cleanup(handle));
                }
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
        await withPlatform("darwin", () =>
            withBunWhich((command) => (command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null), async () => {
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

    test("macOS fallback executes with a writable sandbox temp directory", async () => {
        const captureDir = tempDir("smithers-sandbox-exec-capture-");
        const fakeSandboxExec = makeFakeSandboxExecBin(captureDir);
        await withPlatform("darwin", () =>
            withBunWhich((command) => (command === "sandbox-exec" ? fakeSandboxExec : null), async () => {
                const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                    executor.create(
                        configFor(tempDir("smithers-sandbox-exec-"), "run-sandbox-exec-temp", "sandbox", "bubblewrap"),
                    ),
                );
                try {
                    await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                        executor.execute(
                            'test -d "$TMPDIR" && test "$HOME" = "$TMPDIR" && printf ok > "$TMPDIR/check.txt" && printf ok > ../result/macos-temp.txt',
                            handle,
                        ),
                    );
                    const expectedTempPath = join(handle.sandboxRoot, "tmp");
                    expect(readFileSync(join(captureDir, "home.txt"), "utf8").trim()).toBe(expectedTempPath);
                    expect(readFileSync(join(captureDir, "tmpdir.txt"), "utf8").trim()).toBe(expectedTempPath);
                    expect(readFileSync(join(captureDir, "args.txt"), "utf8")).toContain(expectedTempPath);
                    expect(readFileSync(join(expectedTempPath, "check.txt"), "utf8")).toBe("ok");
                    expect(readFileSync(join(handle.resultPath, "macos-temp.txt"), "utf8")).toBe("ok");
                } finally {
                    await runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.cleanup(handle));
                }
            }),
        );
    });

    test("docker executor uses docker info before creating the workspace", async () => {
        const fakeDocker = makeFakeDockerBin();
        await withEnv({ PATH: `${fakeDocker}:${process.env.PATH ?? ""}` }, async () => {
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
});
