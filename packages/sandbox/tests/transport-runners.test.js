import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SandboxEntityExecutor } from "../src/effect/sandbox-entity.js";
import { CodeplaneSandboxExecutorLive, DockerSandboxExecutorLive } from "../src/effect/http-runner.js";
import { BubblewrapSandboxExecutorLive } from "../src/effect/socket-runner.js";
import { SandboxTransport, layerForSandboxRuntime, resolveSandboxRuntime } from "../src/transport.js";
import {
  bubblewrapArgs,
  dockerArgs,
  normalizeSandboxHandleControls,
  sandboxExecArgs,
  sandboxRunnerEnv,
  spawnSandboxCommand,
} from "../src/effect/process-runner.js";

const isWindows = process.platform === "win32";

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
    Effect.flatMap(SandboxEntityExecutor, (executor) => effect(executor)).pipe(Effect.provide(layer)),
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
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
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
  } finally {
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
  } finally {
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
  expect(existsSync(handle.requestPath)).toBe(false);
  expect(existsSync(handle.resultPath)).toBe(true);
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

/**
 * @param {string} captureDir
 */
function makeFakeSandboxExecBin(captureDir) {
  return makeFakeBin(
    "sandbox-exec",
    [
      "#!/bin/sh",
      `: > ${JSON.stringify(join(captureDir, "args.txt"))}`,
      "home=''",
      "tmpdir=''",
      "last=''",
      'for arg in "$@"; do',
      `  printf '%s\\n' "$arg" >> ${JSON.stringify(join(captureDir, "args.txt"))}`,
      '  case "$arg" in',
      "    HOME=*) home=${arg#HOME=} ;;",
      "    TMPDIR=*) tmpdir=${arg#TMPDIR=} ;;",
      "  esac",
      '  last="$arg"',
      "done",
      `printf '%s\\n' "$home" > ${JSON.stringify(join(captureDir, "home.txt"))}`,
      `printf '%s\\n' "$tmpdir" > ${JSON.stringify(join(captureDir, "tmpdir.txt"))}`,
      'HOME="$home" TMPDIR="$tmpdir" /bin/sh -lc "$last"',
      "",
    ].join("\n"),
  );
}

describe("sandbox transport runners", () => {
  test("runner env is minimal and excludes ambient secrets", async () => {
    await withEnv({ SMITHERS_TEST_SECRET: "do-not-inherit" }, async () => {
      const env = sandboxRunnerEnv();
      expect(env.PATH).toBeString();
      expect(env.SMITHERS_TEST_SECRET).toBeUndefined();
    });
  });

  test("bubblewrap args clear ambient env and pass only explicit sandbox env", () => {
    const handle = {
      requestPath: "/tmp/request",
      resultPath: "/tmp/result",
      allowNetwork: false,
      env: { SAFE_VALUE: "ok" },
    };
    const args = bubblewrapArgs("env", handle);
    expect(args).toContain("--clearenv");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--setenv");
    expect(args).toContain("SAFE_VALUE");
    expect(args).toContain("ok");
    expect(args.join(" ")).not.toContain("SMITHERS_TEST_SECRET");
    expect(args).toContain("--ro-bind");
  });

  test("docker args map explicit sandbox controls", () => {
    const handle = {
      requestPath: "/tmp/request",
      resultPath: "/tmp/result",
      allowNetwork: true,
      image: "example/sandbox:latest",
      env: { SAFE_VALUE: "ok" },
      ports: [{ host: 7331, container: 7331 }],
      volumes: [{ host: "/tmp/cache", container: "/cache", readonly: true }],
      memoryLimit: "512m",
      cpuLimit: "0.5",
    };
    const args = dockerArgs("smithers up bundle.tsx", handle);
    expect(args).toContain("--env");
    expect(args).toContain("SAFE_VALUE=ok");
    expect(args).toContain("--publish");
    expect(args).toContain("7331:7331");
    expect(args).toContain("/tmp/cache:/cache:ro");
    expect(args).toContain("--memory");
    expect(args).toContain("512m");
    expect(args).toContain("--cpus");
    expect(args).toContain("0.5");
    expect(args).not.toContain("--network");
  });

  test.skipIf(isWindows)("local sandbox handles merge egress proxy config into sandbox env", async () => {
    const fake = makeFakeBin("bwrap");
    await withPlatform("linux", () =>
      withBunWhich(
        (command) => (command === "bwrap" ? fake.binPath : null),
        async () => {
          const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
            executor.create({
              ...configFor(tempDir("smithers-bubblewrap-egress-"), "run-bwrap-egress", "sandbox", "bubblewrap"),
              allowNetwork: true,
              env: { SAFE_VALUE: "ok" },
              egress: {
                httpsProxy: "http://127.0.0.1:8080",
                httpProxy: "http://127.0.0.1:8080",
                noProxy: ["127.0.0.1", "localhost"],
                caCertPem: "-----BEGIN CERTIFICATE-----\nproxy-ca\n-----END CERTIFICATE-----\n",
                secretBindings: { "sk-proxy-anthropic": "anthropic" },
              },
            }),
          );
          expect(handle.egress).toMatchObject({
            httpsProxy: "http://127.0.0.1:8080",
            httpProxy: "http://127.0.0.1:8080",
            noProxy: "127.0.0.1,localhost",
          });
          expect(handle.env).toEqual({
            SAFE_VALUE: "ok",
            HTTP_PROXY: "http://127.0.0.1:8080",
            HTTPS_PROXY: "http://127.0.0.1:8080",
            NO_PROXY: "127.0.0.1,localhost",
            NODE_EXTRA_CA_CERTS: "/workspace/.smithers/egress/ca.crt",
          });

          const bwrap = bubblewrapArgs("env", handle);
          expect(bwrap).toContain("HTTPS_PROXY");
          expect(bwrap).toContain("http://127.0.0.1:8080");
          expect(bwrap).toContain("NODE_EXTRA_CA_CERTS");
          expect(bwrap).toContain("/workspace/.smithers/egress/ca.crt");

          const docker = dockerArgs("env", { ...handle, runtime: "docker", image: "node:22-slim" });
          expect(docker).toContain("--env");
          expect(docker).toContain("HTTPS_PROXY=http://127.0.0.1:8080");
          expect(docker).toContain("NODE_EXTRA_CA_CERTS=/workspace/.smithers/egress/ca.crt");
        },
      ),
    );
  });

  test("sandbox-exec re-points the caCertPem NODE_EXTRA_CA_CERTS at the real on-disk requestPath CA", () => {
    const handle = {
      runtime: "bubblewrap",
      runId: "run",
      sandboxId: "sandbox",
      sandboxRoot: "/tmp/sandbox",
      requestPath: "/tmp/sandbox/request",
      resultPath: "/tmp/sandbox/result",
      allowNetwork: true,
      egress: {
        caCertPem: "-----BEGIN CERTIFICATE-----\nproxy-ca\n-----END CERTIFICATE-----\n",
      },
      env: {
        HTTPS_PROXY: "http://127.0.0.1:8080",
        NODE_EXTRA_CA_CERTS: "/workspace/.smithers/egress/ca.crt",
      },
    };

    const args = sandboxExecArgs("npm test", handle);
    expect(args).toContain("NODE_EXTRA_CA_CERTS=/tmp/sandbox/request/.smithers/egress/ca.crt");
    expect(args).not.toContain("NODE_EXTRA_CA_CERTS=/workspace/.smithers/egress/ca.crt");
    expect(args).toContain("HTTPS_PROXY=http://127.0.0.1:8080");
    expect(args[1]).toContain('(subpath "/tmp/sandbox/request")');
  });

  test("sandbox-exec preserves a user-supplied caCertPath under egress unchanged", () => {
    const handle = {
      runtime: "bubblewrap",
      runId: "run",
      sandboxId: "sandbox",
      sandboxRoot: "/tmp/sandbox",
      requestPath: "/tmp/sandbox/request",
      resultPath: "/tmp/sandbox/result",
      allowNetwork: true,
      egress: {
        caCertPath: "/etc/ssl/custom-ca.crt",
      },
      env: {
        NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.crt",
      },
    };

    const args = sandboxExecArgs("npm test", handle);
    expect(args).toContain("NODE_EXTRA_CA_CERTS=/etc/ssl/custom-ca.crt");
  });

  test("sandbox controls fail closed when a runtime cannot enforce them", () => {
    expect(() =>
      dockerArgs("run", {
        requestPath: "/tmp/request",
        resultPath: "/tmp/result",
        allowNetwork: false,
        ports: [{ host: 8080, container: 8080 }],
      }),
    ).toThrow("allowNetwork=true");
    expect(() =>
      bubblewrapArgs("run", {
        requestPath: "/tmp/request",
        resultPath: "/tmp/result",
        memoryLimit: "1g",
      }),
    ).toThrow("memoryLimit");
    expect(() =>
      sandboxExecArgs("run", {
        sandboxRoot: "/tmp/sandbox",
        requestPath: "/tmp/request",
        resultPath: "/tmp/result",
        volumes: [{ host: "/tmp/cache", container: "/cache" }],
      }),
    ).toThrow("volume remapping");
  });

  test.skipIf(isWindows)("bubblewrap executor creates, ships, executes, collects, and cleans up", async () => {
    const fake = makeFakeBin("bwrap");
    await withPlatform("linux", () =>
      withBunWhich(
        (command) => (command === "bwrap" ? fake.binPath : null),
        async () => {
          await expectExecutorLifecycle(
            BubblewrapSandboxExecutorLive,
            configFor(tempDir("smithers-bubblewrap-"), "run-bwrap", "sandbox-bwrap", "bubblewrap"),
          );
        },
      ),
    );
  });

  test.skipIf(isWindows)("bubblewrap executor does not inherit host secrets", async () => {
    const fake = makeFakeBin(
      "bwrap",
      ["#!/bin/sh", "last=''", 'for arg in "$@"; do', '  last="$arg"', "done", '/bin/sh -lc "$last"', ""].join("\n"),
    );
    await withEnv({ SMITHERS_SECRET_SHOULD_NOT_LEAK: "secret" }, () =>
      withPlatform("linux", () =>
        withBunWhich(
          (command) => (command === "bwrap" ? fake.binPath : null),
          async () => {
            const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
              executor.create(configFor(tempDir("smithers-bubblewrap-"), "run-bwrap-env", "sandbox", "bubblewrap")),
            );
            try {
              await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
                executor.execute('test -z "$SMITHERS_SECRET_SHOULD_NOT_LEAK" && printf ok > ../result/env.txt', handle),
              );
              expect(readFileSync(join(handle.resultPath, "env.txt"), "utf8")).toBe("ok");
            } finally {
              await runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.cleanup(handle));
            }
            expect(existsSync(handle.requestPath)).toBe(false);
            expect(existsSync(handle.resultPath)).toBe(true);
          },
        ),
      ),
    );
  });

  test("bubblewrap executor reports the missing Linux binary", async () => {
    await withPlatform("linux", () =>
      withBunWhich(
        () => null,
        async () => {
          await expect(
            runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
              executor.create(configFor(tempDir("smithers-bubblewrap-"), "run-no-bwrap", "sandbox", "bubblewrap")),
            ),
          ).rejects.toThrow("bwrap");
        },
      ),
    );
  });

  test("bubblewrap executor reports the missing macOS fallback binary", async () => {
    await withPlatform("darwin", () =>
      withBunWhich(
        () => null,
        async () => {
          await expect(
            runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
              executor.create(
                configFor(tempDir("smithers-bubblewrap-"), "run-no-sandbox-exec", "sandbox", "bubblewrap"),
              ),
            ),
          ).rejects.toThrow("sandbox-exec");
        },
      ),
    );
  });

  test("bubblewrap executor accepts the macOS fallback binary", async () => {
    const fake = makeFakeBin("sandbox-exec");
    await withPlatform("darwin", () =>
      withBunWhich(
        (command) => (command === "sandbox-exec" ? fake.binPath : null),
        async () => {
          const handle = await runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
            executor.create(configFor(tempDir("smithers-bubblewrap-"), "run-sandbox-exec", "sandbox", "bubblewrap")),
          );
          expect(handle.runtime).toBe("bubblewrap");
          expect(existsSync(handle.requestPath)).toBe(true);
          expect(existsSync(handle.resultPath)).toBe(true);
        },
      ),
    );
  });

  test.skipIf(isWindows)("macOS fallback executes with a writable sandbox temp directory", async () => {
    const captureDir = tempDir("smithers-sandbox-exec-capture-");
    const fake = makeFakeSandboxExecBin(captureDir);
    await withPlatform("darwin", () =>
      withBunWhich(
        (command) => (command === "sandbox-exec" ? fake.binPath : null),
        async () => {
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
          expect(existsSync(join(handle.sandboxRoot, "tmp"))).toBe(false);
          expect(existsSync(handle.resultPath)).toBe(true);
        },
      ),
    );
  });

  test.skipIf(isWindows)("docker executor uses docker info before creating the workspace", async () => {
    const fakeDocker = makeFakeDockerBin();
    await withEnv({ PATH: `${fakeDocker.binDir}:${process.env.PATH ?? ""}` }, async () => {
      await expectExecutorLifecycle(
        DockerSandboxExecutorLive,
        configFor(tempDir("smithers-docker-"), "run-docker", "sandbox-docker", "docker"),
      );
    });
  });

  test.skipIf(isWindows)("docker executor reports an unreachable daemon", async () => {
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
          executor.create(configFor(tempDir("smithers-codeplane-"), "run-codeplane-fail", "sandbox", "codeplane")),
        ),
      ).rejects.toThrow("requires CODEPLANE_API_URL and CODEPLANE_API_KEY");
    });
  });

  test("codeplane executor reports unsupported direct command execution", async () => {
    await withEnv({ CODEPLANE_API_URL: "http://codeplane.test", CODEPLANE_API_KEY: "test-key" }, async () => {
      const handle = await runExecutor(CodeplaneSandboxExecutorLive, (executor) =>
        executor.create(configFor(tempDir("smithers-codeplane-"), "run-codeplane", "sandbox", "codeplane")),
      );

      await expect(
        runExecutor(CodeplaneSandboxExecutorLive, (executor) => executor.execute("npm test", handle)),
      ).rejects.toThrow("remote Codeplane worker integration");
    });
  });

  test("macOS fallback execute reports the missing sandbox-exec binary", async () => {
    await withPlatform("darwin", () =>
      withBunWhich(
        () => null,
        async () => {
          const rootDir = tempDir("smithers-sandbox-exec-missing-");
          const sandboxRoot = join(rootDir, ".smithers", "sandboxes", "run-no-exec", "sandbox");
          const handle = {
            runtime: "bubblewrap",
            runId: "run-no-exec",
            sandboxId: "sandbox",
            sandboxRoot,
            requestPath: join(sandboxRoot, "request"),
            resultPath: join(sandboxRoot, "result"),
            allowNetwork: false,
          };

          await expect(
            runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.execute("npm test", handle)),
          ).rejects.toThrow("sandbox-exec");
        },
      ),
    );
  });

  test("runtime selection covers all transport layer branches", async () => {
    expect(layerForSandboxRuntime("docker")).toBeDefined();
    expect(layerForSandboxRuntime("codeplane")).toBeDefined();
    expect(layerForSandboxRuntime("bubblewrap")).toBeDefined();
    expect(() => layerForSandboxRuntime("cloudflare")).toThrow("requires a provider");
    expect(() => layerForSandboxRuntime("unknown-runtime")).toThrow("Unsupported sandbox runtime");
    expect(resolveSandboxRuntime("docker")).toBe("docker");
    expect(resolveSandboxRuntime("codeplane")).toBe("codeplane");
    expect(resolveSandboxRuntime("bubblewrap")).toBe("bubblewrap");
    expect(resolveSandboxRuntime("cloudflare")).toBe("cloudflare");
    expect(() => resolveSandboxRuntime("unknown-runtime")).toThrow("Unsupported sandbox runtime");
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

  test("docker volumes may not override the /workspace or /result runtime mounts", () => {
    const base = {
      runtime: "docker",
      runId: "run",
      sandboxId: "sandbox",
      sandboxRoot: "/tmp/sandbox",
      requestPath: "/tmp/sandbox/request",
      resultPath: "/tmp/sandbox/result",
      allowNetwork: false,
    };
    for (const container of ["/workspace", "/workspace/sub", "/result", "/result/sub"]) {
      expect(() =>
        dockerArgs("npm test", {
          ...base,
          volumes: [{ host: "/tmp/evil", container, readonly: false }],
        }),
      ).toThrow("may not override /workspace or /result");
    }
    // Positive control: a prefix-but-not-subpath sibling is allowed through.
    const args = dockerArgs("npm test", {
      ...base,
      volumes: [{ host: "/tmp/cache", container: "/result-sibling", readonly: true }],
    });
    expect(args).toContain("/tmp/cache:/result-sibling:ro");
  });

  test("bubblewrap volumes may not override the /workspace or /result runtime mounts", () => {
    const base = {
      runtime: "bubblewrap",
      runId: "run",
      sandboxId: "sandbox",
      sandboxRoot: "/tmp/sandbox",
      requestPath: "/tmp/sandbox/request",
      resultPath: "/tmp/sandbox/result",
      allowNetwork: false,
    };
    // A writable bind at /workspace would shadow the --ro-bind request mount
    // (later bwrap binds win), escaping the read-only isolation.
    for (const container of ["/workspace", "/workspace/sub", "/result", "/result/sub"]) {
      expect(() =>
        bubblewrapArgs("npm test", {
          ...base,
          volumes: [{ host: "/tmp/evil", container, readonly: false }],
        }),
      ).toThrow("may not override /workspace or /result");
    }
    // Positive control: a /workspace-sibling prefix is allowed and bound writably.
    const args = bubblewrapArgs("npm test", {
      ...base,
      volumes: [{ host: "/tmp/cache", container: "/workspace-sibling", readonly: false }],
    });
    expect(args).toContain("--bind");
    expect(args).toContain("/workspace-sibling");
  });
});

describe("spawnSandboxCommand cancellation", () => {
  // Regression: the run's AbortSignal was never threaded into the sandbox
  // command spawn, so a cancel/down left the docker/bwrap/sandbox-exec command
  // running until its 10-minute default timeout. The signal now SIGKILLs the
  // detached process group on abort.
  test.skipIf(isWindows)(
    "aborting the signal kills the command promptly instead of running to its timeout",
    async () => {
      const controller = new AbortController();
      const start = performance.now();
      const promise = Effect.runPromise(
        spawnSandboxCommand("sleep", ["30"], {
          cwd: process.cwd(),
          runtime: "test",
          signal: controller.signal,
        }),
      );
      setTimeout(() => controller.abort(), 100);
      // The killed process fails the effect rather than hanging for 30s / the
      // 10-minute sandbox timeout. The exact code races (PROCESS_ABORTED vs a
      // SANDBOX_EXECUTION_FAILED wrapping the SIGKILL exit), so we only require
      // that it (a) terminated, (b) actually started — not a missing-binary
      // spawn failure — and (c) died promptly. Without the signal threading the
      // effect would not settle until the command's own timeout.
      let caught;
      try {
        await promise;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(caught?.code).not.toBe("PROCESS_SPAWN_FAILED");
      expect(performance.now() - start).toBeLessThan(8000);
    },
    15_000,
  );
});

/**
 * Create a real regular file and return its path, so a runtime that expects a
 * directory ancestor there fails with ENOTDIR (deterministic on any host,
 * including root, where permission bits would be ignored).
 * @param {string} prefix
 */
function makeFilePath(prefix) {
  const path = join(tempDir(prefix), "afile");
  writeFileSync(path, "x", "utf8");
  return path;
}

/**
 * @param {string} runtime
 * @param {string} requestPath
 * @param {string} [resultPath]
 */
function bareHandle(runtime, requestPath, resultPath = "/tmp/does-not-matter/result") {
  return {
    runtime,
    runId: "run",
    sandboxId: "sandbox",
    sandboxRoot: "/tmp/does-not-matter",
    requestPath,
    resultPath,
    allowNetwork: false,
  };
}

describe("sandbox config normalization", () => {
  test("sandboxRunnerEnv falls back to a default PATH when the host has none", async () => {
    await withEnv({ PATH: undefined, TMPDIR: undefined, TMP: undefined, TEMP: undefined }, async () => {
      const env = sandboxRunnerEnv();
      expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    });
  });

  test("rejects malformed env, ports, volumes, and resource limits", () => {
    expect(() => normalizeSandboxHandleControls({ env: "nope" })).toThrow("flat object");
    expect(() => normalizeSandboxHandleControls({ env: { "1bad": "v" } })).toThrow("valid environment variable names");
    expect(() => normalizeSandboxHandleControls({ env: { GOOD: 123 } })).toThrow("must be strings");
    expect(() => normalizeSandboxHandleControls({ env: { GOOD: "x".repeat(64 * 1024 + 1) } })).toThrow(
      "outside supported bounds",
    );
    expect(() => normalizeSandboxHandleControls({ ports: "nope" })).toThrow("must be an array");
    expect(() => normalizeSandboxHandleControls({ ports: ["nope"] })).toThrow("must be objects");
    expect(() => normalizeSandboxHandleControls({ ports: [{ host: 0, container: 1 }] })).toThrow("between 1 and 65535");
    expect(() => normalizeSandboxHandleControls({ volumes: "nope" })).toThrow("must be an array");
    expect(() => normalizeSandboxHandleControls({ volumes: ["nope"] })).toThrow("must be objects");
    expect(() => normalizeSandboxHandleControls({ volumes: [{ host: "relative", container: "/abs" }] })).toThrow(
      "must be an absolute path",
    );
    expect(() => normalizeSandboxHandleControls({ memoryLimit: "not-a-limit" })).toThrow("resource limit");
  });

  test("accepts and canonicalizes valid resource limits, ports, volumes, and workspace controls", () => {
    const controls = normalizeSandboxHandleControls({
      memoryLimit: "512m",
      cpuLimit: "0.5",
      ports: [{ host: 8080, container: 80 }],
      volumes: [{ host: "/tmp/cache", container: "/cache", readonly: true }],
      workspace: { name: "  ws  ", snapshotId: "  snap  ", idleTimeoutSecs: 12.9, persistence: "sticky" },
    });
    expect(controls.memoryLimit).toBe("512m");
    expect(controls.cpuLimit).toBe("0.5");
    expect(controls.ports).toEqual([{ host: 8080, container: 80 }]);
    expect(controls.volumes).toEqual([{ host: "/tmp/cache", container: "/cache", readonly: true }]);
    expect(controls.workspace).toEqual({ name: "ws", snapshotId: "snap", idleTimeoutSecs: 12, persistence: "sticky" });
  });

  test("rejects malformed workspace controls", () => {
    expect(() => normalizeSandboxHandleControls({ workspace: { name: "" } })).toThrow("non-empty name");
    expect(() => normalizeSandboxHandleControls({ workspace: { name: "ok", snapshotId: "" } })).toThrow(
      "snapshotId must be a non-empty string",
    );
    expect(() => normalizeSandboxHandleControls({ workspace: { name: "ok", idleTimeoutSecs: -1 } })).toThrow(
      "idleTimeoutSecs must be a non-negative number",
    );
    expect(() => normalizeSandboxHandleControls({ workspace: { name: "ok", persistence: "weird" } })).toThrow(
      "persistence must be ephemeral or sticky",
    );
  });

  test("bubblewrap fails closed on port publishing, cpu limits, and managed workspaces", () => {
    const base = { requestPath: "/tmp/request", resultPath: "/tmp/result", allowNetwork: false };
    expect(() => bubblewrapArgs("run", { ...base, ports: [{ host: 1, container: 1 }] })).toThrow(
      "explicit port publishing",
    );
    expect(() => bubblewrapArgs("run", { ...base, cpuLimit: "0.5" })).toThrow("cpuLimit");
    expect(() => bubblewrapArgs("run", { ...base, workspace: { name: "ws" } })).toThrow("managed workspace controls");
  });

  test("docker fails closed on managed workspace controls", () => {
    expect(() =>
      dockerArgs("run", {
        requestPath: "/tmp/request",
        resultPath: "/tmp/result",
        allowNetwork: false,
        workspace: { name: "ws" },
      }),
    ).toThrow("managed workspace controls");
  });
});

describe("spawnSandboxCommand result mapping", () => {
  test.skipIf(isWindows)("resolves with exitCode 0 when the sandbox command succeeds", async () => {
    const result = await Effect.runPromise(
      spawnSandboxCommand("sh", ["-c", "exit 0"], { cwd: process.cwd(), runtime: "test", timeoutMs: 10_000 }),
    );
    expect(result).toEqual({ exitCode: 0 });
  });

  test.skipIf(isWindows)("fails with the runtime, command, and exit code when the command exits nonzero", async () => {
    let caught;
    try {
      await Effect.runPromise(
        spawnSandboxCommand("sh", ["-c", "printf oops 1>&2; exit 7"], {
          cwd: process.cwd(),
          runtime: "widget",
          timeoutMs: 10_000,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String(caught?.message ?? "")).toContain("widget sandbox command exited with code 7");
  });
});

describe("sandbox transport executor error paths", () => {
  test.skipIf(isWindows)("docker create surfaces a workspace mkdir failure after docker info succeeds", async () => {
    const fakeDocker = makeFakeDockerBin();
    // rootDir is a real directory so `docker info` (cwd=rootDir) succeeds, but
    // `.smithers` is a regular file so the request-path mkdir hits ENOTDIR.
    const rootDir = tempDir("smithers-docker-badroot-");
    writeFileSync(join(rootDir, ".smithers"), "x", "utf8");
    await withEnv({ PATH: `${fakeDocker.binDir}:${process.env.PATH ?? ""}` }, async () => {
      await expect(
        runExecutor(DockerSandboxExecutorLive, (executor) =>
          executor.create(configFor(rootDir, "run-docker-badroot", "sandbox", "docker")),
        ),
      ).rejects.toThrow(/create docker sandbox workspace|ENOTDIR/i);
    });
  });

  test("docker ship surfaces a copy failure for a missing bundle", async () => {
    const handle = bareHandle("docker", join(tempDir("smithers-docker-ship-"), "request"));
    await expect(
      runExecutor(DockerSandboxExecutorLive, (executor) =>
        executor.ship(join(tempDir("smithers-docker-nobundle-"), "does-not-exist"), handle),
      ),
    ).rejects.toThrow(/ship docker bundle|ENOENT/i);
  });

  test("docker cleanup surfaces an rm failure", async () => {
    const handle = bareHandle("docker", join(makeFilePath("smithers-docker-clean-"), "request"));
    await expect(runExecutor(DockerSandboxExecutorLive, (executor) => executor.cleanup(handle))).rejects.toThrow(
      /cleanup docker sandbox workspace|ENOTDIR/i,
    );
  });

  test("codeplane create surfaces a workspace mkdir failure", async () => {
    const fileRoot = makeFilePath("smithers-codeplane-badroot-");
    await withEnv({ CODEPLANE_API_URL: "http://codeplane.test", CODEPLANE_API_KEY: "test-key" }, async () => {
      await expect(
        runExecutor(CodeplaneSandboxExecutorLive, (executor) =>
          executor.create(configFor(fileRoot, "run-codeplane-badroot", "sandbox", "codeplane")),
        ),
      ).rejects.toThrow(/create codeplane sandbox workspace|ENOTDIR/i);
    });
  });

  test("codeplane ship surfaces a copy failure for a missing bundle", async () => {
    const handle = bareHandle("codeplane", join(tempDir("smithers-codeplane-ship-"), "request"));
    await expect(
      runExecutor(CodeplaneSandboxExecutorLive, (executor) =>
        executor.ship(join(tempDir("smithers-codeplane-nobundle-"), "does-not-exist"), handle),
      ),
    ).rejects.toThrow(/ship codeplane bundle|ENOENT/i);
  });

  test("codeplane cleanup surfaces an rm failure", async () => {
    const handle = bareHandle("codeplane", join(makeFilePath("smithers-codeplane-clean-"), "request"));
    await expect(runExecutor(CodeplaneSandboxExecutorLive, (executor) => executor.cleanup(handle))).rejects.toThrow(
      /cleanup codeplane sandbox workspace|ENOTDIR/i,
    );
  });

  test.skipIf(isWindows)("bubblewrap create surfaces a workspace mkdir failure", async () => {
    const fake = makeFakeBin("sandbox-exec");
    const fileRoot = makeFilePath("smithers-bubblewrap-badroot-");
    await withPlatform("darwin", () =>
      withBunWhich(
        (command) => (command === "sandbox-exec" ? fake.binPath : null),
        async () => {
          await expect(
            runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
              executor.create(configFor(fileRoot, "run-bwrap-badroot", "sandbox", "bubblewrap")),
            ),
          ).rejects.toThrow(/create sandbox workspace|ENOTDIR/i);
        },
      ),
    );
  });

  test("bubblewrap ship surfaces a copy failure for a missing bundle", async () => {
    const handle = bareHandle("bubblewrap", join(tempDir("smithers-bubblewrap-ship-"), "request"));
    await expect(
      runExecutor(BubblewrapSandboxExecutorLive, (executor) =>
        executor.ship(join(tempDir("smithers-bubblewrap-nobundle-"), "does-not-exist"), handle),
      ),
    ).rejects.toThrow(/ship sandbox bundle|ENOENT/i);
  });

  test("bubblewrap cleanup surfaces an rm failure", async () => {
    const handle = bareHandle("bubblewrap", join(makeFilePath("smithers-bubblewrap-clean-"), "request"));
    await expect(runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.cleanup(handle))).rejects.toThrow(
      /cleanup sandbox workspace|ENOTDIR/i,
    );
  });

  test("bubblewrap execute reports the missing Linux bwrap binary", async () => {
    const handle = bareHandle("bubblewrap", "/tmp/does-not-matter/request");
    await withPlatform("linux", () =>
      withBunWhich(
        () => null,
        async () => {
          await expect(
            runExecutor(BubblewrapSandboxExecutorLive, (executor) => executor.execute("npm test", handle)),
          ).rejects.toThrow("bwrap");
        },
      ),
    );
  });
});

describe("sandbox transport service", () => {
  test("builds the transport service and maps entity operation failures", async () => {
    await withEnv({ CODEPLANE_API_URL: "http://codeplane.test", CODEPLANE_API_KEY: "test-key" }, async () => {
      const handle = bareHandle("codeplane", "/tmp/does-not-matter/request");
      let caught;
      try {
        await Effect.runPromise(
          Effect.flatMap(SandboxTransport, (svc) => svc.execute("npm test", handle)).pipe(
            Effect.provide(layerForSandboxRuntime("codeplane")),
            Effect.scoped,
          ),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(String(caught?.message ?? "")).toContain("sandbox entity execute failed");
    });
  });
});
