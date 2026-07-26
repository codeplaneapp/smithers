// Unit coverage for the tail pane's single-key steering controls after the
// steer rework: `spawnSteer` (the argv a tail pane fires for `smithers steer`,
// now with a steer message or a `--takeover` flag), `attachTailKeyControls` (the
// live-tail key listener: `s` opens an in-pane steer input line, `h` takes the
// run over), and the takeover-only `lingerUntilClosed`. Driven with a
// `PassThrough` stdin and injected `enqueue`/`onTakeover`/`spawnFn` seams — no
// TTY, no real child process, so it runs in CI.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  attachTailKeyControls,
  lingerUntilClosed,
  spawnSteer,
  TAIL_LINGER_HINT,
  TAIL_STEER_HINT,
} from "../src/tail.js";

const EXEC = "/fake/bun";
const ENTRY = "/fake/cli/index.js";

/** A fake spawn: records every call and returns a controllable child. */
function makeFakeSpawn() {
  /** @type {Array<{ cmd: string, args: string[], opts: any, child: EventEmitter }>} */
  const calls = [];
  /** @type {typeof import("node:child_process").spawn} */
  const spawnFn = /** @type {any} */ (
    (cmd, args, opts) => {
      const child = new EventEmitter();
      calls.push({ cmd, args, opts, child });
      return child;
    }
  );
  return { calls, spawnFn };
}

/** Let a PassThrough deliver its buffered `data` events. */
function tick() {
  return new Promise((r) => setTimeout(r, 10));
}

// ── spawnSteer argv shapes ───────────────────────────────────────────────────

test("spawnSteer builds `<exec> <entry> steer <runId> --node <nodeId>` and inherits env/stdio", () => {
  const { calls, spawnFn } = makeFakeSpawn();
  const env = { HERDR_SOCKET_PATH: "/sock" };
  spawnSteer({ runId: "run-1", nodeId: "node-a", cliEntry: ENTRY, spawnFn, execPath: EXEC, env });
  expect(calls).toHaveLength(1);
  expect(calls[0].cmd).toBe(EXEC);
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a"]);
  expect(calls[0].opts.env).toBe(env);
  expect(calls[0].opts.stdio).toBe("inherit");
});

test("spawnSteer omits --node for a whole-run steer (no nodeId)", () => {
  const { calls, spawnFn } = makeFakeSpawn();
  spawnSteer({ runId: "run-1", cliEntry: ENTRY, spawnFn, execPath: EXEC });
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1"]);
});

test("spawnSteer appends a steer message as the trailing positional (spaces preserved as one token)", () => {
  const { calls, spawnFn } = makeFakeSpawn();
  spawnSteer({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    message: "prefer the smaller change",
    spawnFn,
    execPath: EXEC,
  });
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "prefer the smaller change"]);
  // Piped so alt-screen HUDs are not torn by CLI chrome.
  expect(calls[0].opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
});

test("spawnSteer appends --takeover for the hijack hand-off", () => {
  const { calls, spawnFn } = makeFakeSpawn();
  spawnSteer({ runId: "run-1", nodeId: "node-a", cliEntry: ENTRY, takeover: true, spawnFn, execPath: EXEC });
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "--takeover"]);
  expect(calls[0].opts.stdio).toBe("inherit");
});

test("spawnSteer herdr takeover uses --yes + HERDR_HIJACK env for a fresh tab", () => {
  const { calls, spawnFn } = makeFakeSpawn();
  // Mimic attachTailKeyControls herdr path
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/sock" };
  spawnSteer({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    takeover: true,
    yes: true,
    spawnFn,
    execPath: EXEC,
    env: { ...env, SMITHERS_HERDR_HIJACK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "--takeover", "--yes"]);
  expect(calls[0].opts.env.SMITHERS_HERDR_HIJACK).toBe("1");
  expect(calls[0].opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
});

// ── attachTailKeyControls: `s` in-pane steer input line ──────────────────────

test("attachTailKeyControls prints the `s steer · h hijack · q close` hint", () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const emitted = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: (t) => emitted.push(t),
  });
  try {
    expect(emitted.join("")).toContain(TAIL_STEER_HINT);
    expect(TAIL_STEER_HINT).toBe("s steer · h hijack · q close");
  } finally {
    controls.stop();
  }
});

test("`s` opens an input line, chars echo, Backspace edits, Enter enqueues the exact message", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const emitted = [];
  /** @type {string[]} */
  const enqueued = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: (t) => emitted.push(t),
    enqueue: (m) => enqueued.push(m),
  });
  try {
    stdin.write("s");
    await tick();
    // The input prompt is shown and no steer has been queued yet.
    expect(emitted.join("")).toContain("steer: ");
    expect(enqueued).toHaveLength(0);
    // Type "hello", then backspace once -> "hell".
    stdin.write("hello");
    await tick();
    stdin.write("");
    await tick();
    expect(emitted.join("")).toContain("h");
    expect(emitted.join("")).toContain("\b \b");
    // Enter submits the collected line.
    stdin.write("\r");
    await tick();
    expect(enqueued).toEqual(["hell"]);
  } finally {
    controls.stop();
  }
});

test("Backspace deletes a whole astral code point (emoji), not a lone surrogate half", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const enqueued = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: () => {},
    enqueue: (m) => enqueued.push(m),
  });
  try {
    stdin.write("s");
    await tick();
    // Type an ASCII char then an astral (surrogate-pair) emoji.
    stdin.write("a😀");
    await tick();
    // One Backspace deletes the entire emoji code point, leaving exactly "a".
    stdin.write("\x7f");
    await tick();
    stdin.write("\r");
    await tick();
    // A UTF-16 `slice(0, -1)` would leave "a\uD83D" (a lone high surrogate); the
    // code-point-aware delete leaves "a".
    expect(enqueued).toEqual(["a"]);
  } finally {
    controls.stop();
  }
});

test("Esc cancels the input line (no steer queued) and the controls keep working", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const emitted = [];
  /** @type {string[]} */
  const enqueued = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: (t) => emitted.push(t),
    enqueue: (m) => enqueued.push(m),
  });
  try {
    stdin.write("s");
    await tick();
    stdin.write("abc");
    await tick();
    stdin.write(""); // Esc
    await tick();
    expect(enqueued).toHaveLength(0);
    expect(emitted.join("")).toContain("(steer cancelled)");
    // A fresh `s` + "x" + Enter still enqueues, proving the machine reset.
    stdin.write("s");
    await tick();
    stdin.write("x\r");
    await tick();
    expect(enqueued).toEqual(["x"]);
  } finally {
    controls.stop();
  }
});

test("in input mode, `q` is literal text (does not close) and only Enter submits", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const enqueued = [];
  let closed = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {
      closed += 1;
    },
    stdin,
    emit: () => {},
    enqueue: (m) => enqueued.push(m),
  });
  try {
    stdin.write("s");
    await tick();
    stdin.write("quit");
    await tick();
    // `q` inside the line did not close the tail.
    expect(closed).toBe(0);
    stdin.write("\r");
    await tick();
    expect(enqueued).toEqual(["quit"]);
  } finally {
    controls.stop();
  }
});

// ── attachTailKeyControls: `h` hijack ───────────────────────────────────────

test("`h` invokes the hijack seam once (injected onTakeover), and never closes", async () => {
  const stdin = new PassThrough();
  let takeovers = 0;
  let closed = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {
      closed += 1;
    },
    stdin,
    emit: () => {},
    onTakeover: () => {
      takeovers += 1;
    },
  });
  try {
    stdin.write("h");
    await tick();
    expect(takeovers).toBe(1);
    expect(closed).toBe(0);
  } finally {
    controls.stop();
  }
});

test("`S` does not hijack (no legacy alias)", async () => {
  const stdin = new PassThrough();
  let takeovers = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: () => {},
    onTakeover: () => {
      takeovers += 1;
    },
  });
  try {
    stdin.write("S");
    await tick();
    expect(takeovers).toBe(0);
    stdin.write("H");
    await tick();
    expect(takeovers).toBe(0);
  } finally {
    controls.stop();
  }
});

test("`h` spawns `steer --takeover` and is debounced while its child is alive", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: () => {},
    spawnFn,
    execPath: EXEC,
    // Isolate from ambient HERDR_* (this suite may run inside herdr).
    env: {},
  });
  try {
    stdin.write("h");
    await tick();
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "--takeover"]);
    // Once the hand-off child exits, `h` hijacks again.
    calls[0].child.emit("close", 0);
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(2);
  } finally {
    controls.stop();
  }
});

test("takeover suspends the tail's key reading while the hand-off child is alive, and re-arms on close", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  let closed = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {
      closed += 1;
    },
    stdin,
    emit: () => {},
    spawnFn,
    execPath: EXEC,
    env: {},
  });
  try {
    // Armed initially.
    expect(stdin.listenerCount("data")).toBe(1);
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(1);
    // While the inherited `steer --takeover` child owns the TTY the tail drops
    // its `data` listener, so keystrokes (which the child reads) never reach the
    // tail handler — a `q` here does NOT close the pane mid-hand-off.
    expect(stdin.listenerCount("data")).toBe(0);
    stdin.write("q");
    await tick();
    expect(closed).toBe(0);
    // The child exiting re-arms key reading identically...
    calls[0].child.emit("close", 0);
    await tick();
    expect(stdin.listenerCount("data")).toBe(1);
    // ...and keys work again: the held `q` now reaches the re-armed handler.
    expect(closed).toBe(1);
  } finally {
    controls.stop();
  }
});

// ── herdr-pane hijack sibling-safety guard (inFlightSiblings) ────────────────
// A herdr node pane auto-confirms hijack with `--yes`, which would abort every
// in-flight sibling agent run-wide. The guard refuses that when siblings exist,
// and — critically — FAILS CLOSED if the sibling set can't be read.

const HERDR_PANE_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" };

test("herdr pane `h` REFUSES hijack when in-flight siblings exist (no spawn, warns with ids)", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  /** @type {string[]} */
  const notes = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    onDock: (s) => {
      if (s.note) notes.push(s.note);
    },
    spawnFn,
    execPath: EXEC,
    env: HERDR_PANE_ENV,
    // Returns a string[] of sibling node ids (NOT a count) — the guard must
    // key on `.length`, not coerce the array with `> 0`.
    inFlightSiblings: async () => ["node-b", "node-c"],
  });
  try {
    stdin.write("h");
    await tick();
    // Guard fired: NO `steer --takeover` child was spawned.
    expect(calls).toHaveLength(0);
    const warn = notes.join(" ");
    expect(warn).toContain("node-b");
    expect(warn).toContain("node-c");
    expect(warn).toContain("real terminal");
  } finally {
    controls.stop();
  }
});

test("herdr pane `h` PROCEEDS with hijack when no siblings are in flight", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    onDock: () => {},
    spawnFn,
    execPath: EXEC,
    env: HERDR_PANE_ENV,
    inFlightSiblings: async () => [],
  });
  try {
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(1);
    // herdr path auto-confirms with --yes and pipes (keeps the pane HUD).
    expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "--takeover", "--yes"]);
    expect(calls[0].opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  } finally {
    controls.stop();
  }
});

test("herdr pane `h` FAILS CLOSED when the sibling read throws (refuses, no spawn)", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  /** @type {string[]} */
  const notes = [];
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    onDock: (s) => {
      if (s.note) notes.push(s.note);
    },
    spawnFn,
    execPath: EXEC,
    env: HERDR_PANE_ENV,
    // A transient lock / closed adapter must NOT read as "zero siblings".
    inFlightSiblings: async () => {
      throw new Error("db locked");
    },
  });
  try {
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(0);
    const warn = notes.join(" ");
    expect(warn).toContain("could not verify");
    expect(warn).toContain("real terminal");
  } finally {
    controls.stop();
  }
});

test("takeover re-arms key reading when the hand-off child errors (not just close)", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {},
    stdin,
    emit: () => {},
    spawnFn,
    execPath: EXEC,
    env: {},
  });
  try {
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(1);
    expect(stdin.listenerCount("data")).toBe(0);
    // An `error` on the child re-arms just like `close` does.
    calls[0].child.emit("error", new Error("spawn failed"));
    await tick();
    expect(stdin.listenerCount("data")).toBe(1);
    // Hijack is no longer debounced: a fresh `h` spawns again.
    stdin.write("h");
    await tick();
    expect(calls).toHaveLength(2);
  } finally {
    controls.stop();
  }
});

// ── attachTailKeyControls: close + teardown ──────────────────────────────────

test("q, Enter, and raw Ctrl-C (0x03) all invoke onClose; s opens input instead of closing", async () => {
  for (const key of ["q", "\r", ""]) {
    const stdin = new PassThrough();
    let closed = 0;
    const controls = attachTailKeyControls({
      runId: "run-1",
      nodeId: "node-a",
      cliEntry: ENTRY,
      onClose: () => {
        closed += 1;
      },
      stdin,
      emit: () => {},
    });
    try {
      stdin.write(key);
      await tick();
      expect(closed).toBe(1);
    } finally {
      controls.stop();
    }
  }
  // `s` opens the input line rather than closing.
  const stdin = new PassThrough();
  let closed = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {
      closed += 1;
    },
    stdin,
    emit: () => {},
    enqueue: () => {},
  });
  try {
    stdin.write("s");
    await tick();
    expect(closed).toBe(0);
  } finally {
    controls.stop();
  }
});

test("stop() drops the listener so later keys do nothing", async () => {
  const stdin = new PassThrough();
  let closed = 0;
  let takeovers = 0;
  const controls = attachTailKeyControls({
    runId: "run-1",
    nodeId: "node-a",
    cliEntry: ENTRY,
    onClose: () => {
      closed += 1;
    },
    stdin,
    emit: () => {},
    onTakeover: () => {
      takeovers += 1;
    },
  });
  controls.stop();
  stdin.write("h");
  stdin.write("q");
  await tick();
  expect(takeovers).toBe(0);
  expect(closed).toBe(0);
});

// ── lingerUntilClosed: takeover only (finished run) ──────────────────────────

test("lingerUntilClosed with steer: `h` hijacks (does not close), `q` closes; linger hint shown", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  /** @type {string[]} */
  const emitted = [];
  const closed = lingerUntilClosed({
    stdin,
    emit: (t) => emitted.push(t),
    steer: { runId: "run-1", nodeId: "node-a", cliEntry: ENTRY, spawnFn, execPath: EXEC },
  });
  // Intro advertises the base close controls and the takeover-only linger hint.
  expect(emitted.join("")).toContain("Lingering");
  expect(emitted.join("")).toContain(TAIL_LINGER_HINT);
  expect(TAIL_LINGER_HINT).toBe("h hijack · q close");
  // `h` hijacks the finished run (a `--takeover` hand-off) without resolving.
  stdin.write("h");
  await tick();
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual([ENTRY, "steer", "run-1", "--node", "node-a", "--takeover"]);
  let settled = false;
  closed.then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  // While the hand-off child owns the TTY the linger's key reading is suspended
  // (so it does not fight the child for keystrokes); the child exiting re-arms it.
  expect(stdin.listenerCount("data")).toBe(0);
  calls[0].child.emit("close", 0);
  await tick();
  expect(stdin.listenerCount("data")).toBe(1);
  // `q` closes it.
  stdin.write("q");
  await closed;
});

test("lingerUntilClosed suspends key reading while the takeover child is alive, re-arms on close", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  const closed = lingerUntilClosed({
    stdin,
    emit: () => {},
    steer: { runId: "run-1", nodeId: "node-a", cliEntry: ENTRY, spawnFn, execPath: EXEC },
  });
  // Armed initially.
  expect(stdin.listenerCount("data")).toBe(1);
  stdin.write("h");
  await tick();
  expect(calls).toHaveLength(1);
  // Detached while the child owns the TTY: with no `data` listener a keystroke
  // structurally cannot reach the linger handler, so `q` cannot close it out from
  // under the child.
  expect(stdin.listenerCount("data")).toBe(0);
  let settled = false;
  closed.then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  // The child exiting re-arms the listener identically, and keys work again.
  calls[0].child.emit("close", 0);
  await tick();
  expect(stdin.listenerCount("data")).toBe(1);
  stdin.write("q");
  await closed;
});

test("lingerUntilClosed without steer: `s` is inert and does not spawn a steer", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  const closed = lingerUntilClosed({ stdin, emit: () => {} });
  stdin.write("s");
  await tick();
  expect(calls).toHaveLength(0);
  stdin.write("q");
  await closed;
  void spawnFn;
});

test("lingerUntilClosed with steer: lowercase `s` explains steer is unavailable (does not hijack)", async () => {
  const stdin = new PassThrough();
  const { calls, spawnFn } = makeFakeSpawn();
  /** @type {string[]} */
  const emitted = [];
  const closed = lingerUntilClosed({
    stdin,
    emit: (t) => emitted.push(t),
    steer: { runId: "run-1", nodeId: "node-a", cliEntry: ENTRY, spawnFn, execPath: EXEC },
  });
  stdin.write("s");
  await tick();
  expect(calls).toHaveLength(0);
  expect(emitted.join("")).toMatch(/run finished|steer/i);
  stdin.write("q");
  await closed;
});
