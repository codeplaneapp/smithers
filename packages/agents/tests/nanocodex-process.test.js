import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createNanocodexSpawnSpec,
  resolveNanocodexExecutable,
  runNanocodexCapabilities,
  runNanocodexProcess,
} from "../internal/nanocodex/process.js";

const NODE_EXECUTABLE = Bun.which("node") ?? process.execPath;

const RAPID_DAEMON_SOURCE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const heartbeat = process.env.HEARTBEAT;
const socket = process.env.SOCKET;
const server = net.createServer(() => {});
server.listen(socket, () => {
  fs.appendFileSync(heartbeat, "x");
  setInterval(() => fs.appendFileSync(heartbeat, "x"), 5);
});
`;

const RAPID_WORKER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const daemonSource = ${JSON.stringify(RAPID_DAEMON_SOURCE)};
process.on("message", (message) => {
  if (message !== "detach") return;
  const daemon = spawn(process.execPath, ["-e", daemonSource, process.env.SENTINEL], {
    detached: true,
    stdio: ["ignore", "inherit", "ignore"],
    env: {
      HEARTBEAT: process.env.HEARTBEAT,
      SOCKET: process.env.SOCKET,
    },
  });
  daemon.unref();
  const ready = setInterval(() => {
    if (!existsSync(process.env.HEARTBEAT)) return;
    clearInterval(ready);
    process.send?.("daemon-ready", () => process.exit(0));
  }, 1);
});
process.send?.("worker-ready");
`;

const THREADED_DAEMON_SOURCE = String.raw`
const fs = require("node:fs");
setInterval(() => fs.appendFileSync(process.env.HEARTBEAT, "x"), 5);
`;

const THREADED_WORKER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { parentPort } = require("node:worker_threads");
const daemonSource = ${JSON.stringify(THREADED_DAEMON_SOURCE)};
const daemon = spawn(process.execPath, ["-e", daemonSource, process.env.SENTINEL], {
  detached: true,
  stdio: "ignore",
  env: { HEARTBEAT: process.env.HEARTBEAT },
});
daemon.unref();
const ready = setInterval(() => {
  if (!existsSync(process.env.HEARTBEAT)) return;
  clearInterval(ready);
  parentPort.postMessage(daemon.pid);
  setInterval(() => {}, 1000);
}, 1);
`;

const CHILD_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const readline = require("node:readline");
const { Worker } = require("node:worker_threads");
const mode = process.env.MODE;
const rapidWorkerSource = ${JSON.stringify(RAPID_WORKER_SOURCE)};
const threadedWorkerSource = ${JSON.stringify(THREADED_WORKER_SOURCE)};
let heartbeat;
let threadedWorker;

const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const emitAndExit = (record, code = 0) => {
  clearInterval(heartbeat);
  process.stdout.write(JSON.stringify(record) + "\n", () => process.exit(code));
};

if (mode === "invalid-json") {
  process.stdout.write("{not-json}\n");
} else if (mode === "duplicate-json") {
  process.stdout.write('{"type":"hello","type":"agent.event","data":{}}\n');
} else if (mode === "invalid-utf8") {
  process.stdout.write(Buffer.from([0xff, 0x0a]));
} else if (mode === "before-hello") {
  emit({ type: "agent.event", data: {} });
} else if (mode === "no-hello") {
  process.exit(0);
} else if (mode === "delayed-hello") {
  setTimeout(() => emit({ type: "hello", data: {} }), 200);
} else if (mode === "fragmented") {
  const line = Buffer.from(JSON.stringify({ type: "hello", data: { text: "ready-😀" } }) + "\r\n");
  const emoji = line.indexOf(Buffer.from("😀"));
  process.stdout.write(line.subarray(0, emoji + 1));
  setTimeout(() => process.stdout.write(line.subarray(emoji + 1)), 5);
} else if (mode === "hello-exit") {
  process.stdout.write(JSON.stringify({ type: "hello", data: {} }) + "\n", () => process.exit(7));
} else {
  emit({
    type: "hello",
    data: mode === "env" ? {
      inherited: process.env.SMITHERS_PROCESS_INHERITED,
      explicit: process.env.EXPLICIT_VALUE,
      cwd: process.cwd(),
      argvContainsSecret: process.argv.join(" ").includes(process.env.API_KEY || "missing-secret"),
    } : {},
  });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const record = JSON.parse(line);
  if (record.type === "turn.start") {
    if (mode === "normal" || mode === "fragmented" || mode === "env") {
      process.stdout.write(
        JSON.stringify({ type: "agent.event", data: { text: "one" } }) + "\n" +
        JSON.stringify({ type: "agent.event", data: { text: "two" } }) + "\n"
      );
      emitAndExit({ type: "turn.completed", data: { finalMessage: "done" } });
    } else if (mode === "terminal-nonzero") {
      emitAndExit({ type: "turn.failed", data: { code: "provider" } }, 9);
    } else if (mode === "crash-secret") {
      const secret = process.env.API_KEY || process.env.ACCESS_TOKEN;
      const midpoint = Math.floor(secret.length / 2);
      process.stderr.write("API_KEY=" + secret.slice(0, midpoint));
      setTimeout(() => process.stderr.write(secret.slice(midpoint)), 3);
      setTimeout(() => process.stderr.write(" bearer sk-abcdefghijk " + "x".repeat(512), () => process.exit(7)), 6);
    } else if (mode === "oversize-line") {
      process.stdout.write("x".repeat(201) + "\n");
    } else if (mode === "aggregate-overflow") {
      for (let i = 0; i < 20; i += 1) emit({ type: "agent.event", data: { i, pad: "x".repeat(20) } });
    } else if (mode === "hello-no-terminal") {
      process.exit(0);
    } else if (mode === "idle") {
      // Wait for turn.cancel.
    } else if (mode === "stderr-active") {
      let count = 0;
      heartbeat = setInterval(() => {
        process.stderr.write(".");
        count += 1;
        if (count === 5) emitAndExit({ type: "turn.completed", data: {} });
      }, 12);
    } else if (mode === "total-active") {
      let count = 0;
      heartbeat = setInterval(() => emit({ type: "agent.event", data: { count: count++ } }), 10);
    } else if (mode === "descendant") {
      const descendant = spawn(
        process.execPath,
        ["-e", "const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,'x'),10)", process.env.SENTINEL],
        { detached: true, stdio: "ignore", env: { HEARTBEAT: process.env.HEARTBEAT } },
      );
      descendant.unref();
      emit({ type: "descendant", data: { pid: descendant.pid } });
    } else if (mode === "thread-descendant") {
      threadedWorker = new Worker(threadedWorkerSource, {
        eval: true,
        env: {
          HEARTBEAT: process.env.HEARTBEAT,
          SENTINEL: process.env.SENTINEL,
        },
      });
      threadedWorker.once("message", (pid) => emit({ type: "descendant", data: { pid } }));
    } else if (mode === "rapid-detached") {
      const descendant = spawn(
        process.execPath,
        ["-e", "const fs=require('fs');setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,'x'),5)", process.env.SENTINEL],
        { detached: true, stdio: "ignore", env: { HEARTBEAT: process.env.HEARTBEAT } },
      );
      descendant.unref();
      const ready = setInterval(() => {
        if (!existsSync(process.env.HEARTBEAT)) return;
        clearInterval(ready);
        // Stay alive long enough for the supplemental 250ms census to observe
        // this direct descendant before the worker exits.
        setTimeout(() => {
          emitAndExit({ type: "turn.completed", data: { finalMessage: "done" } });
        }, 300);
      }, 1);
    } else if (mode === "rapid-race") {
      const worker = spawn(process.execPath, ["-e", rapidWorkerSource], {
        detached: true,
        stdio: ["ignore", "inherit", "ignore", "ipc"],
        env: {
          HEARTBEAT: process.env.HEARTBEAT,
          SOCKET: process.env.SOCKET,
          SENTINEL: process.env.SENTINEL,
        },
      });
      worker.on("message", (message) => {
        if (message === "worker-ready") {
          process.stdout.write(JSON.stringify({ type: "census-reset", data: {} }) + "\n", () => {
            worker.send("detach");
          });
        } else if (message === "daemon-ready") {
          worker.disconnect();
          worker.unref();
          emitAndExit({ type: "turn.completed", data: { finalMessage: "done" } });
        }
      });
    }
  } else if (record.type === "turn.cancel") {
    emit({ type: "cancel.observed", data: record });
    if (mode !== "descendant" && mode !== "cancel-hang") emitAndExit({ type: "turn.cancelled", data: {} });
  }
});

if (mode === "descendant") process.on("SIGTERM", () => {});
`;

/** @param {unknown} value */
function validateRecord(value) {
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw new Error("invalid record");
  return value;
}

/** @param {unknown} value */
function isHello(value) {
  return value?.type === "hello";
}

/**
 * @param {string} mode
 * @param {Partial<Parameters<typeof runNanocodexProcess>[0]>} [overrides]
 */
function optionsFor(mode, overrides = {}) {
  const { env, ...otherOverrides } = overrides;
  return {
    command: NODE_EXECUTABLE,
    args: ["-e", CHILD_SOURCE],
    cwd: process.cwd(),
    inheritEnv: false,
    validateRecord,
    isHello,
    onHello: async (_hello, control) => control.send({ type: "turn.start", requestId: "request-1" }),
    cancelGraceMs: 30,
    termGraceMs: 30,
    killWaitMs: 500,
    terminalExitGraceMs: 100,
    ...otherOverrides,
    env: { MODE: mode, ...env },
  };
}

/** @param {Promise<unknown>} promise */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

/** @param {string} sentinel */
function linuxPidsWithSentinel(sentinel) {
  if (process.platform !== "linux") return [];
  const matches = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(sentinel)) matches.push(Number(entry));
    } catch {
      // The process exited while /proc was being scanned.
    }
  }
  return matches;
}

/** @param {string} path */
function socketIsListening(path) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

/** @param {number} milliseconds */
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("runNanocodexProcess", () => {
  test("waits for a validated hello, serializes records, and returns the marked terminal", async () => {
    const order = [];
    const validated = [];
    const records = [];
    const result = await runNanocodexProcess(
      optionsFor("normal", {
        validateRecord(value) {
          validated.push(value.type);
          return validateRecord(value);
        },
        async onHello(hello, control) {
          order.push(hello.type);
          await control.send({ type: "turn.start", requestId: "request-1" });
          order.push("started");
        },
        async onRecord(record, control) {
          await Promise.resolve();
          records.push(record.type);
          order.push(record.type);
          if (record.type === "turn.completed") control.markTerminal(record);
        },
      }),
    );

    expect(validated).toEqual(["hello", "agent.event", "agent.event", "turn.completed"]);
    expect(records).toEqual(["agent.event", "agent.event", "turn.completed"]);
    expect(order.slice(0, 2)).toEqual(["hello", "started"]);
    expect(result.terminal).toEqual({ type: "turn.completed", data: { finalMessage: "done" } });
    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "", stderrTruncated: false });
  });

  test("accepts fragmented multibyte UTF-8, CRLF, and multiple records per chunk", async () => {
    const records = [];
    const result = await runNanocodexProcess(
      optionsFor("fragmented", {
        onHello(hello, control) {
          expect(hello.data.text).toBe("ready-😀");
          return control.send({ type: "turn.start" });
        },
        onRecord(record, control) {
          records.push(record.type);
          if (record.type === "turn.completed") control.markTerminal(record);
        },
      }),
    );
    expect(records).toEqual(["agent.event", "agent.event", "turn.completed"]);
    expect(result.exitCode).toBe(0);
  });

  test("counts input record bodies without charging the trailing LF delimiter", async () => {
    const start = { type: "turn.start", requestId: "request-😀", data: { prompt: "exact" } };
    const body = JSON.stringify(start);
    let wire;
    const result = await runNanocodexProcess(
      optionsFor("normal", {
        maxInputRecordBytes: Buffer.byteLength(body, "utf8"),
        onHello(_hello, control) {
          return control.send(start);
        },
        onRecord(record, control) {
          if (record.type === "turn.completed") control.markTerminal(record);
        },
        spawnFn(command, args, options) {
          const child = spawn(command, args, options);
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (payload, encoding, callback) => {
            wire = Buffer.from(String(payload), "utf8");
            return write(payload, encoding, callback);
          };
          return child;
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(wire.subarray(0, -1).toString("utf8")).toBe(body);
    expect(wire[wire.byteLength - 1]).toBe(0x0a);
    expect(wire.byteLength).toBe(Buffer.byteLength(body, "utf8") + 1);
  });

  test("resolves a bare payload from a cwd-relative explicit PATH and spawns it directly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanocodex-explicit-path-"));
    const name = `private-node-${process.pid}-${Date.now()}`;
    const executable = join(directory, name);
    symlinkSync(NODE_EXECUTABLE, executable);
    let spawnedCommand;
    try {
      const result = await runNanocodexProcess(
        optionsFor("normal", {
          command: name,
          cwd: directory,
          env: { PATH: "." },
          onRecord(record, control) {
            if (record.type === "turn.completed") control.markTerminal(record);
          },
          spawnFn(command, args, options) {
            spawnedCommand = command;
            expect(args).not.toContain("--unshare-pid");
            expect(args[0]).not.toBe("--");
            return spawn(command, args, options);
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(isAbsolute(spawnedCommand)).toBe(true);
      expect(spawnedCommand).toBe(realpathSync(executable));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not wrap the worker in Bubblewrap even when bwrap is on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "nanocodex-fake-bwrap-"));
    const executable = join(directory, "bwrap");
    writeFileSync(executable, "#!/bin/sh\nexit 99\n", "utf8");
    chmodSync(executable, 0o755);
    try {
      const spec = createNanocodexSpawnSpec(
        NODE_EXECUTABLE,
        ["serve", "--protocol-version", "1"],
        { PATH: "." },
        directory,
      );
      expect(spec.command).toBe(realpathSync(NODE_EXECUTABLE));
      expect(spec.args).toEqual(["serve", "--protocol-version", "1"]);
      expect(spec.command).not.toBe(realpathSync(executable));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("supervises a timed-out capabilities probe through verified child closure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanocodex-capabilities-timeout-"));
    const executable = join(directory, "capabilities-hang.mjs");
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, "utf8");
    chmodSync(executable, 0o755);
    let wrapperPid;
    try {
      const error = await rejection(
        runNanocodexCapabilities({
          command: executable,
          cwd: directory,
          env: {},
          inheritEnv: false,
          timeoutMs: 20,
          spawnFn(command, args, options) {
            const child = spawn(command, args, options);
            wrapperPid = child.pid;
            return child;
          },
        }),
      );
      expect(error).toMatchObject({ code: "bridge_capabilities_timeout" });
      expect(() => process.kill(wrapperPid, 0)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(["stdout", "stderr"])("supervises capability %s stream errors", async (stream) => {
    const directory = mkdtempSync(join(tmpdir(), "nanocodex-capabilities-stream-error-"));
    const executable = join(directory, "capabilities-stream-error.mjs");
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, "utf8");
    chmodSync(executable, 0o755);
    try {
      const error = await rejection(
        runNanocodexCapabilities({
          command: executable,
          cwd: directory,
          env: {},
          inheritEnv: false,
          spawnFn(command, args, options) {
            const child = spawn(command, args, options);
            setTimeout(() => child[stream].emit("error", new Error("synthetic stream failure")), 5);
            return child;
          },
        }),
      );
      expect(error).toMatchObject({ code: "bridge_capabilities_failed" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("supervises turn stderr stream errors", async () => {
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("idle", {
          spawnFn(command, args, options) {
            const child = spawn(command, args, options);
            setTimeout(() => child.stderr.emit("error", new Error("synthetic stream failure")), 5);
            return child;
          },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "bridge_protocol_error" });
  });

  test("does not inherit ambient environment unless explicitly requested and never puts env secrets in argv", async () => {
    const previous = process.env.SMITHERS_PROCESS_INHERITED;
    process.env.SMITHERS_PROCESS_INHERITED = "ambient-sentinel";
    try {
      let isolatedHello;
      await runNanocodexProcess(
        optionsFor("env", {
          env: { EXPLICIT_VALUE: "explicit", API_KEY: "super-secret-sentinel" },
          onHello(hello, control) {
            isolatedHello = hello;
            return control.send({ type: "turn.start" });
          },
          onRecord(record, control) {
            if (record.type === "turn.completed") control.markTerminal(record);
          },
        }),
      );
      expect(isolatedHello.data).toMatchObject({
        explicit: "explicit",
        cwd: process.cwd(),
        argvContainsSecret: false,
      });
      expect(isolatedHello.data.inherited).toBeUndefined();

      let inheritedHello;
      await runNanocodexProcess(
        optionsFor("env", {
          env: { EXPLICIT_VALUE: "explicit" },
          inheritEnv: true,
          onHello(hello, control) {
            inheritedHello = hello;
            return control.send({ type: "turn.start" });
          },
          onRecord(record, control) {
            if (record.type === "turn.completed") control.markTerminal(record);
          },
        }),
      );
      expect(inheritedHello.data.inherited).toBe("ambient-sentinel");
    } finally {
      if (previous === undefined) delete process.env.SMITHERS_PROCESS_INHERITED;
      else process.env.SMITHERS_PROCESS_INHERITED = previous;
    }
  });

  test("redacts and bounds stderr in a synthesized crash without exposing argv", async () => {
    const secret = "super-secret-sentinel";
    let publishedStderr = "";
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("crash-secret", {
          env: { API_KEY: secret },
          maxStderrBytes: 96,
          onStderr(value) {
            publishedStderr += value;
          },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "bridge_crashed", exitCode: 7, stderrTruncated: true });
    expect(error.message).not.toContain(secret);
    expect(error.stderr).not.toContain(secret);
    expect(publishedStderr).toBe(error.stderr);
    expect(publishedStderr).not.toContain(secret);
    expect(error.message).not.toContain(CHILD_SOURCE.slice(0, 30));
    expect(error.message).toContain("content suppressed");
    expect(Buffer.byteLength(error.stderr, "utf8")).toBeLessThanOrEqual(96);

    const prefixError = await rejection(
      runNanocodexProcess(optionsFor("crash-secret", { env: { ACCESS_TOKEN: secret }, maxStderrBytes: 8 })),
    );
    expect(prefixError.stderr).not.toContain(secret.slice(0, 8));
    expect(prefixError.message).not.toContain(secret.slice(0, 8));
  });

  test.each([
    ["invalid-json", "invalid JSONL"],
    ["duplicate-json", "invalid JSONL"],
    ["invalid-utf8", "invalid UTF-8"],
    ["before-hello", "before hello"],
    ["no-hello", "before hello"],
  ])("rejects malformed framing or startup ordering: %s", async (mode, message) => {
    const error = await rejection(runNanocodexProcess(optionsFor(mode)));
    expect(error.code).toMatch(/^bridge_(protocol_error|crashed)$/);
    expect(error.message).toContain(message);
  });

  test("enforces independent physical-line and aggregate protocol budgets", async () => {
    const lineError = await rejection(
      runNanocodexProcess(optionsFor("oversize-line", { maxLineBytes: 200, maxProtocolBytes: 2_000 })),
    );
    expect(lineError).toMatchObject({ code: "bridge_protocol_error" });
    expect(lineError.message).toContain("line exceeded 200 bytes");

    const aggregateError = await rejection(
      runNanocodexProcess(optionsFor("aggregate-overflow", { maxLineBytes: 200, maxProtocolBytes: 220 })),
    );
    expect(aggregateError).toMatchObject({ code: "bridge_protocol_error" });
    expect(aggregateError.message).toContain("aggregate bytes");
  });

  test("rejects a clean child exit that omits the mandatory terminal record", async () => {
    const error = await rejection(runNanocodexProcess(optionsFor("hello-no-terminal")));
    expect(error).toMatchObject({ code: "bridge_terminal_missing", exitCode: 0 });
    expect(error.message).toContain("without a terminal record");
  });

  test("classifies an initial turn.start child-close write failure as a crash", async () => {
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("hello-exit", {
          async onHello(_hello, control) {
            await delay(20);
            await control.send({ type: "turn.start" });
          },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "bridge_crashed", exitCode: 7 });
    expect(error.code).not.toBe("bridge_handler_error");
  });

  test("bounds a generic async record handler after child close", async () => {
    const startedAt = Date.now();
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("normal", {
          killWaitMs: 20,
          onRecord() {
            return new Promise(() => {});
          },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "bridge_handler_error" });
    expect(error.message).toContain("did not settle after bridge exit");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("reports process lifecycle and bounded stderr activity without giving callbacks lifecycle ownership", async () => {
    const phases = [];
    let stderr = "";
    const result = await runNanocodexProcess(
      optionsFor("stderr-active", {
        idleTimeoutMs: 100,
        onProcess: (event) => phases.push(event.phase),
        onStderr: (text) => {
          stderr += text;
        },
        onRecord(record, control) {
          if (record.type === "turn.completed") control.markTerminal(record);
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(phases).toEqual(["started", "exited"]);
    expect(stderr).toBe("[Nanocodex bridge stderr content suppressed]");
  });

  test("sends one correlated graceful cancellation on AbortSignal before escalation", async () => {
    const controller = new AbortController();
    const observed = [];
    let cancellationCalls = 0;
    let bridgeReady;
    const ready = new Promise((resolve) => {
      bridgeReady = resolve;
    });
    const pending = runNanocodexProcess(
      optionsFor("idle", {
        signal: controller.signal,
        async onHello(_hello, control) {
          await control.send({ type: "turn.start", requestId: "request-1" });
          bridgeReady();
        },
        onCancel({ reason, send }) {
          cancellationCalls += 1;
          return send({ type: "turn.cancel", requestId: "request-1", sessionId: "session-1", data: { reason } });
        },
        onRecord(record) {
          observed.push(record);
        },
      }),
    );
    await ready;
    controller.abort();
    const error = await rejection(pending);
    expect(error).toMatchObject({ code: "bridge_aborted", reason: "aborted" });
    expect(cancellationCalls).toBe(1);
    expect(observed.some((record) => record.type === "cancel.observed")).toBe(true);
  });

  test("queues one cancellation behind an in-flight turn.start and waits for its write before escalation", async () => {
    const controller = new AbortController();
    const writeOrder = [];
    const callbackReleases = [];
    const callbackWaiters = [];
    const phases = [];
    let cancellationCalls = 0;

    const waitForWriteCallback = (count) => {
      if (callbackReleases.length >= count) return Promise.resolve();
      return new Promise((resolve) => callbackWaiters.push({ count, resolve }));
    };
    const notifyWriteCallbacks = () => {
      for (let index = callbackWaiters.length - 1; index >= 0; index -= 1) {
        if (callbackReleases.length < callbackWaiters[index].count) continue;
        callbackWaiters.splice(index, 1)[0].resolve();
      }
    };

    const pending = runNanocodexProcess(
      optionsFor("cancel-hang", {
        signal: controller.signal,
        cancelGraceMs: 100,
        termGraceMs: 0,
        onProcess: (event) => phases.push(event.phase),
        onCancel({ reason, send }) {
          cancellationCalls += 1;
          return send({ type: "turn.cancel", requestId: "request-1", data: { reason } });
        },
        spawnFn(command, args, options) {
          const child = spawn(command, args, options);
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (payload, encoding, callback) => {
            writeOrder.push(JSON.parse(String(payload)).type);
            return write(payload, encoding, (error) => {
              callbackReleases.push(() => callback(error));
              notifyWriteCallbacks();
            });
          };
          return child;
        },
      }),
    );

    await waitForWriteCallback(1);
    controller.abort();
    await Promise.resolve();
    expect(cancellationCalls).toBe(1);
    expect(writeOrder).toEqual(["turn.start"]);

    callbackReleases[0]();
    await waitForWriteCallback(2);
    expect(cancellationCalls).toBe(1);
    expect(writeOrder).toEqual(["turn.start", "turn.cancel"]);
    expect(phases).toEqual(["started"]);

    await delay(10);
    expect(phases).toEqual(["started"]);
    callbackReleases[1]();
    const error = await rejection(pending);
    expect(error).toMatchObject({ code: "bridge_aborted", reason: "aborted" });
    expect(cancellationCalls).toBe(1);
    expect(phases).toEqual(["started", "exited"]);
  });

  test("queues cancellation even when an in-flight turn.start outlasts the cancellation grace", async () => {
    const controller = new AbortController();
    let releaseStartWrite;
    let startWriteReady;
    const ready = new Promise((resolve) => {
      startWriteReady = resolve;
    });
    let cancellationCalls = 0;
    const pending = runNanocodexProcess(
      optionsFor("cancel-hang", {
        signal: controller.signal,
        cancelGraceMs: 20,
        termGraceMs: 10,
        onCancel({ reason, send }) {
          cancellationCalls += 1;
          return send({ type: "turn.cancel", requestId: "request-1", data: { reason } });
        },
        spawnFn(command, args, options) {
          const child = spawn(command, args, options);
          const write = child.stdin.write.bind(child.stdin);
          let firstWrite = true;
          child.stdin.write = (payload, encoding, callback) => {
            if (!firstWrite) return write(payload, encoding, callback);
            firstWrite = false;
            return write(payload, encoding, (error) => {
              releaseStartWrite = () => callback(error);
              startWriteReady();
            });
          };
          return child;
        },
      }),
    );

    await ready;
    controller.abort();
    await delay(50);
    expect(cancellationCalls).toBe(1);
    releaseStartWrite();
    const error = await rejection(pending);
    expect(error).toMatchObject({ code: "bridge_aborted", reason: "aborted" });
    expect(cancellationCalls).toBe(1);
  });

  test("does not invoke onHello after cancellation wins during startup", async () => {
    const controller = new AbortController();
    let helloCalls = 0;
    const pending = runNanocodexProcess(
      optionsFor("delayed-hello", {
        signal: controller.signal,
        onHello() {
          helloCalls += 1;
        },
      }),
    );
    setTimeout(() => controller.abort(), 10);
    const error = await rejection(pending);
    expect(error).toMatchObject({ code: "bridge_aborted" });
    expect(helloCalls).toBe(0);
  });

  test("distinguishes total and idle timeouts while stderr/stdout activity resets only idle", async () => {
    const totalError = await rejection(
      runNanocodexProcess(
        optionsFor("total-active", {
          timeoutMs: 200,
          idleTimeoutMs: 500,
          onCancel({ reason, send }) {
            return send({ type: "turn.cancel", data: { reason } });
          },
        }),
      ),
    );
    expect(totalError).toMatchObject({ code: "bridge_timeout", reason: "timeout" });

    const idleError = await rejection(
      runNanocodexProcess(
        optionsFor("idle", {
          timeoutMs: 500,
          idleTimeoutMs: 30,
          onCancel({ reason, send }) {
            return send({ type: "turn.cancel", data: { reason } });
          },
        }),
      ),
    );
    expect(idleError).toMatchObject({ code: "bridge_idle_timeout", reason: "idle_timeout" });

    const activeResult = await runNanocodexProcess(
      optionsFor("stderr-active", {
        // Leave enough startup headroom for a saturated CI host; the child then
        // proves that stderr activity refreshes the timer every 12 ms.
        idleTimeoutMs: 200,
        onRecord(record, control) {
          if (record.type === "turn.completed") control.markTerminal(record);
        },
      }),
    );
    expect(activeResult.exitCode).toBe(0);
  });

  test("a marked JSON terminal remains authoritative over a later non-zero exit", async () => {
    const result = await runNanocodexProcess(
      optionsFor("terminal-nonzero", {
        onRecord(record, control) {
          if (record.type === "turn.failed") control.markTerminal(record);
        },
      }),
    );
    expect(result).toMatchObject({ terminal: { type: "turn.failed" }, exitCode: 9 });
  });

  test("a locally initiated abort remains authoritative when the bridge returns turn.cancelled", async () => {
    const controller = new AbortController();
    let bridgeReady;
    const ready = new Promise((resolve) => {
      bridgeReady = resolve;
    });
    const pending = runNanocodexProcess(
      optionsFor("idle", {
        signal: controller.signal,
        async onHello(_hello, control) {
          await control.send({ type: "turn.start", requestId: "request-1" });
          bridgeReady();
        },
        onCancel({ reason, send }) {
          return send({ type: "turn.cancel", requestId: "request-1", data: { reason } });
        },
        onRecord(record, control) {
          if (record.type === "turn.cancelled") control.markTerminal(record);
        },
      }),
    );
    await ready;
    controller.abort();
    const error = await rejection(pending);
    expect(error).toMatchObject({ code: "bridge_aborted", reason: "aborted" });
    expect(error.terminal).toEqual({ type: "turn.cancelled", data: {} });
    expect(Object.getOwnPropertyDescriptor(error, "terminal")).toMatchObject({ enumerable: false });
  });

  test("uses exactly-once settlement and cancellation under abort/timeout races", async () => {
    const controller = new AbortController();
    let cancellationCalls = 0;
    let bridgeReady;
    const ready = new Promise((resolve) => {
      bridgeReady = resolve;
    });
    const pending = runNanocodexProcess(
      optionsFor("idle", {
        signal: controller.signal,
        timeoutMs: 500,
        async onHello(_hello, control) {
          await control.send({ type: "turn.start" });
          bridgeReady();
        },
        onCancel({ reason, send }) {
          cancellationCalls += 1;
          controller.abort();
          return send({ type: "turn.cancel", data: { reason } });
        },
      }),
    );
    await ready;
    setTimeout(() => controller.abort(), 0);
    const error = await rejection(pending);
    expect(["bridge_aborted", "bridge_timeout"]).toContain(error.code);
    expect(cancellationCalls).toBe(1);
  });

  test.skipIf(process.platform !== "linux")(
    "escalates a hung bridge with an independently grouped Linux descendant",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "nanocodex-hung-containment-"));
      const sentinel = `nanocodex-hung-containment-${process.pid}-${Date.now()}`;
      try {
        const error = await rejection(
          runNanocodexProcess(
            optionsFor("descendant", {
              env: { HEARTBEAT: join(directory, "heartbeat"), SENTINEL: sentinel },
              idleTimeoutMs: 150,
              cancelGraceMs: 20,
              termGraceMs: 20,
              onCancel({ reason, send }) {
                return send({ type: "turn.cancel", data: { reason } });
              },
            }),
          ),
        );
        expect(error).toMatchObject({ code: "bridge_idle_timeout" });
        const heartbeat = join(directory, "heartbeat");
        expect(existsSync(heartbeat)).toBe(true);
        const stoppedAt = readFileSync(heartbeat, "utf8").length;
        await delay(100);
        expect(readFileSync(heartbeat, "utf8").length).toBe(stoppedAt);
        expect(linuxPidsWithSentinel(sentinel)).toEqual([]);
      } finally {
        for (const pid of linuxPidsWithSentinel(sentinel)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Best-effort cleanup if the detached descendant survived.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")("censuses descendants created by a non-leader worker thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanocodex-thread-descendant-"));
    const heartbeat = join(directory, "heartbeat");
    const sentinel = `nanocodex-thread-descendant-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    let descendantPid;
    let bridgeReady;
    const ready = new Promise((resolve) => {
      bridgeReady = resolve;
    });
    try {
      const pending = runNanocodexProcess(
        optionsFor("thread-descendant", {
          env: { HEARTBEAT: heartbeat, SENTINEL: sentinel },
          signal: controller.signal,
          cancelGraceMs: 20,
          termGraceMs: 20,
          onCancel({ reason, send }) {
            return send({ type: "turn.cancel", data: { reason } });
          },
          onRecord(record) {
            if (record.type !== "descendant") return;
            descendantPid = record.data.pid;
            bridgeReady();
          },
          spawnFn(command, args, options) {
            return spawn(command, args, options);
          },
        }),
      );
      await ready;
      expect(readFileSync(heartbeat, "utf8").length).toBeGreaterThan(0);
      controller.abort();
      const error = await rejection(pending);
      expect(error).toMatchObject({ code: "bridge_aborted" });
      expect(() => process.kill(descendantPid, 0)).toThrow();
      const stoppedAt = readFileSync(heartbeat, "utf8").length;
      await delay(100);
      expect(readFileSync(heartbeat, "utf8").length).toBe(stoppedAt);
      expect(linuxPidsWithSentinel(sentinel)).toEqual([]);
    } finally {
      for (const pid of linuxPidsWithSentinel(sentinel)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed census assertion.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux")(
    "settles a completed turn when a detached grandchild inherits stdout and escapes the supplemental census",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "nanocodex-rapid-race-"));
      const heartbeat = join(directory, "heartbeat");
      const socket = join(directory, "daemon.sock");
      const sentinel = `nanocodex-rapid-race-${process.pid}-${Date.now()}`;
      try {
        const result = await runNanocodexProcess(
          optionsFor("rapid-race", {
            env: { HEARTBEAT: heartbeat, SOCKET: socket, SENTINEL: sentinel },
            onRecord(record, control) {
              if (record.type === "turn.completed") control.markTerminal(record);
            },
          }),
        );
        // Direct spawn plus /proc census is best-effort. A fork between
        // censuses may be reaped or may escape; the supervisor must still
        // settle the marked terminal instead of hanging on inherited stdio.
        expect([0, null]).toContain(result.exitCode);
        expect(result.terminal).toMatchObject({ type: "turn.completed" });
      } finally {
        for (const pid of linuxPidsWithSentinel(sentinel)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Best-effort cleanup if the escaped daemon is still running.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "proves the rapid-race fixture escapes when the supplemental census is intentionally bypassed",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "nanocodex-rapid-control-"));
      const heartbeat = join(directory, "heartbeat");
      const socket = join(directory, "daemon.sock");
      const sentinel = `nanocodex-rapid-control-${process.pid}-${Date.now()}`;
      try {
        await runNanocodexProcess(
          optionsFor("rapid-race", {
            env: { HEARTBEAT: heartbeat, SOCKET: socket, SENTINEL: sentinel },
            terminalExitGraceMs: 10,
            termGraceMs: 10,
            killWaitMs: 50,
            onRecord(record, control) {
              if (record.type === "turn.completed") control.markTerminal(record);
            },
            spawnFn(command, args, options) {
              const child = spawn(command, args, options);
              // Negative control: hide the root PID so the supplemental host
              // census cannot reap descendants. Not a production launch mode.
              Object.defineProperty(child, "pid", { configurable: true, value: undefined });
              return child;
            },
          }),
        ).catch((error) => {
          expect(error).toMatchObject({ code: "bridge_cleanup_failed" });
        });
        expect(linuxPidsWithSentinel(sentinel).length).toBeGreaterThan(0);
        expect(await socketIsListening(socket)).toBe(true);
        const before = readFileSync(heartbeat, "utf8").length;
        await delay(50);
        expect(readFileSync(heartbeat, "utf8").length).toBeGreaterThan(before);
      } finally {
        for (const pid of linuxPidsWithSentinel(sentinel)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The test daemon may already have exited.
          }
        }
        await delay(20);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "settles the initiating cancellation when the OS process is gone but Node never emits close",
    async () => {
      const error = await rejection(
        runNanocodexProcess(
          optionsFor("idle", {
            idleTimeoutMs: 20,
            cancelGraceMs: 0,
            termGraceMs: 0,
            killWaitMs: 20,
            onCancel({ reason, send }) {
              return send({ type: "turn.cancel", data: { reason } });
            },
            spawnFn(command, args, options) {
              const child = spawn(command, args, options);
              const once = child.once.bind(child);
              child.once = (event, listener) => (event === "close" ? child : once(event, listener));
              return child;
            },
          }),
        ),
      );
      expect(error).toMatchObject({ code: "bridge_idle_timeout", reason: "idle_timeout" });
    },
  );

  test.skipIf(process.platform !== "linux")(
    "retains an authoritative terminal non-enumerably on cleanup failure",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "nanocodex-terminal-cleanup-"));
      const heartbeat = join(directory, "heartbeat");
      const sentinel = `nanocodex-terminal-cleanup-${process.pid}-${Date.now()}`;
      const terminal = { type: "turn.completed", data: { finalMessage: "done", marker: "terminal-marker" } };
      try {
        const error = await rejection(
          runNanocodexProcess(
            optionsFor("rapid-detached", {
              env: { HEARTBEAT: heartbeat, SENTINEL: sentinel },
              terminalExitGraceMs: 0,
              termGraceMs: 0,
              killWaitMs: 20,
              killFn(pid, signal) {
                if (signal === "SIGKILL" || signal === "SIGTERM") return true;
                return process.kill(pid, signal);
              },
              onRecord(record, control) {
                if (record.type !== "turn.completed") return;
                terminal.type = record.type;
                terminal.data = { ...record.data, marker: terminal.data.marker };
                control.markTerminal(terminal);
              },
            }),
          ),
        );
        expect(error).toMatchObject({ code: "bridge_cleanup_failed" });
        expect(error.terminal).toBe(terminal);
        expect(Object.getOwnPropertyDescriptor(error, "terminal")).toMatchObject({
          enumerable: false,
          value: terminal,
        });
        expect(JSON.stringify(error)).not.toContain("terminal-marker");
      } finally {
        for (const pid of linuxPidsWithSentinel(sentinel)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The stubbed supervisor leaves the detached daemon running.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "cannot report success while a rapid detached daemon survives bridge exit",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "nanocodex-rapid-containment-"));
      const heartbeat = join(directory, "heartbeat");
      const sentinel = `nanocodex-rapid-containment-${process.pid}-${Date.now()}`;
      try {
        const result = await runNanocodexProcess(
          optionsFor("rapid-detached", {
            env: { HEARTBEAT: heartbeat, SENTINEL: sentinel },
            onRecord(record, control) {
              if (record.type === "turn.completed") control.markTerminal(record);
            },
          }),
        );
        expect(result.exitCode).toBe(0);
        const stoppedAt = readFileSync(heartbeat, "utf8").length;
        expect(stoppedAt).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(readFileSync(heartbeat, "utf8").length).toBe(stoppedAt);
      } finally {
        for (const pid of linuxPidsWithSentinel(sentinel)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Best-effort cleanup if the detached daemon survived.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("requires explicit process security boundaries and rejects a pre-aborted signal without spawning", async () => {
    await expect(
      runNanocodexProcess({
        command: NODE_EXECUTABLE,
        args: [],
        cwd: process.cwd(),
        env: {},
        // @ts-expect-error exercised runtime validation
        inheritEnv: undefined,
        validateRecord,
        isHello,
        onHello() {},
      }),
    ).rejects.toThrow("inheritEnv must be explicit");
    await expect(runNanocodexProcess(optionsFor("normal", { spawnFn: "nope" }))).rejects.toThrow(
      "spawnFn must be a function",
    );
    await expect(runNanocodexProcess(optionsFor("normal", { killFn: "nope" }))).rejects.toThrow(
      "killFn must be a function",
    );

    let spawned = 0;
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("normal", {
          signal: AbortSignal.abort(),
          spawnFn() {
            spawned += 1;
            throw new Error("must not spawn");
          },
        }),
      ),
    );
    expect(error).toMatchObject({ code: "bridge_aborted" });
    expect(spawned).toBe(0);
  });

  test("rejects malformed AbortSignal-like input before spawning", async () => {
    let spawned = 0;
    const error = await rejection(
      runNanocodexProcess(
        optionsFor("normal", {
          signal: { aborted: false, addEventListener() {} },
          spawnFn() {
            spawned += 1;
            throw new Error("must not spawn");
          },
        }),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("AbortSignal-like");
    expect(spawned).toBe(0);
  });

  test.each(["timeoutMs", "idleTimeoutMs", "cancelGraceMs", "termGraceMs", "killWaitMs", "terminalExitGraceMs"])(
    "rejects runtime timer overflow before spawning: %s",
    async (name) => {
      let spawned = 0;
      const error = await rejection(
        runNanocodexProcess(
          optionsFor("normal", {
            [name]: 2 ** 31,
            spawnFn() {
              spawned += 1;
              throw new Error("must not spawn");
            },
          }),
        ),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain(name);
      expect(spawned).toBe(0);
    },
  );

  test("requires timer values to be non-negative safe integers", async () => {
    for (const timeoutMs of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const error = await rejection(runNanocodexProcess(optionsFor("normal", { timeoutMs })));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain("safe integer");
    }
  });
});
