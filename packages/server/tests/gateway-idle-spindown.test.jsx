import { afterEach, describe, expect, test } from "bun:test";
import { Gateway } from "../src/gateway.js";

/**
 * Idle spin-down (spec decision 14). The daemon fires onIdle once it has been
 * idle — no WS clients, no in-flight runs, no registered crons or pending
 * timers — for idleTimeoutMs, so an autostarted daemon does not outlive the
 * work that started it. Schedules and live runs/clients keep it alive.
 */

/** @type {Gateway[]} */
const gateways = [];
function makeGateway(options) {
  const gateway = new Gateway(options);
  gateways.push(gateway);
  return gateway;
}

afterEach(() => {
  for (const gateway of gateways.splice(0)) {
    try {
      gateway.stopIdleMonitor();
    } catch {}
  }
});

describe("gateway — idle spin-down", () => {
  test("fires onIdle once when idle for idleTimeoutMs", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 50,
      onIdle: () => {
        fired += 1;
      },
    });
    // Nothing attached; pretend the last activity was long ago.
    gateway.lastActivityMs = 0;
    expect(gateway.isIdle()).toBe(true);
    await gateway.checkIdle();
    expect(fired).toBe(1);
    // Idempotent: a second check does not double-fire.
    await gateway.checkIdle();
    expect(fired).toBe(1);
  });

  test("does NOT fire while a WS client is attached", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 50,
      onIdle: () => {
        fired += 1;
      },
    });
    gateway.lastActivityMs = 0;
    gateway.connections.add(/** @type {any} */ ({ id: "conn-1" }));
    expect(gateway.isIdle()).toBe(false);
    await gateway.checkIdle();
    expect(fired).toBe(0);
  });

  test("does NOT fire while a run is in flight", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 50,
      onIdle: () => {
        fired += 1;
      },
    });
    gateway.lastActivityMs = 0;
    gateway.inflightRuns.set("run-1", Promise.resolve());
    expect(gateway.isIdle()).toBe(false);
    await gateway.checkIdle();
    expect(fired).toBe(0);
  });

  test("does NOT fire while a cron or durable timer is registered (keep-alive)", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 50,
      onIdle: () => {
        fired += 1;
      },
    });
    gateway.lastActivityMs = 0;
    gateway.hasActiveCrons = true;
    expect(gateway.isIdle()).toBe(false);
    await gateway.checkIdle();
    expect(fired).toBe(0);
    gateway.hasActiveCrons = false;
    gateway.hasPendingTimers = true;
    await gateway.checkIdle();
    expect(fired).toBe(0);
  });

  test("does NOT fire before idleTimeoutMs has elapsed", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 60_000,
      onIdle: () => {
        fired += 1;
      },
    });
    // Recent activity: not idle long enough yet.
    gateway.markActivity();
    await gateway.checkIdle();
    expect(fired).toBe(0);
  });

  test("never fires when idleTimeoutMs is 0 (disabled) even if checkIdle is called", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 0,
      onIdle: () => {
        fired += 1;
      },
    });
    gateway.lastActivityMs = 0;
    await gateway.checkIdle();
    expect(fired).toBe(0);
  });

  test("markActivity re-arms after a client returns post-idle-fire", async () => {
    let fired = 0;
    const gateway = makeGateway({
      idleTimeoutMs: 50,
      onIdle: () => {
        fired += 1;
      },
    });
    gateway.lastActivityMs = 0;
    await gateway.checkIdle();
    expect(fired).toBe(1);
    expect(gateway.idleFired).toBe(true);
    // A client comes back: the monitor re-arms and can fire again later.
    gateway.markActivity();
    expect(gateway.idleFired).toBe(false);
    gateway.lastActivityMs = 0;
    await gateway.checkIdle();
    expect(fired).toBe(2);
  });
});
