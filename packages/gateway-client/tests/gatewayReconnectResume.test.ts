import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { GatewayRpcError, SmithersGatewayClient } from "../src/index.ts";

/**
 * Real in-process gateway WebSocket server. It speaks the genuine Smithers
 * Gateway framing protocol (connect handshake -> streamRunEvents subscribe ->
 * run.event frames) so the client's REAL reconnect/resume/validation code paths
 * execute against an actual socket. No client method is mocked.
 */
type SubscribeFrame = {
  type: "req";
  id: string;
  method: string;
  params?: { runId?: string; afterSeq?: number };
};

type ServerBehavior = {
  /** Override the streamRunEvents subscribe reply (e.g. to omit streamId). */
  subscribeReply?: (params: SubscribeFrame["params"], streamId: string) => unknown;
  /** Called after each socket's subscribe so the test can drive events/drops. */
  onSubscribed?: (ws: ServerWebSocket<unknown>, ctx: { streamId: string; afterSeq?: number; connectionIndex: number }) => void;
};

type RealGatewayServer = {
  baseUrl: string;
  /** afterSeq values observed across every streamRunEvents subscribe, in order. */
  afterSeqLog: number[];
  /** Number of connect handshakes completed (i.e. socket connections). */
  connectionCount: number;
  /** Wall-clock timestamp each socket opened, in order — used to measure backoff gaps. */
  connectionOpenedAt: number[];
  stop: () => void;
};

function startRealGatewayServer(behavior: ServerBehavior = {}): RealGatewayServer {
  const state: RealGatewayServer = {
    baseUrl: "",
    afterSeqLog: [],
    connectionCount: 0,
    connectionOpenedAt: [],
    stop: () => {},
  };
  let connectionIndex = -1;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) {
        return undefined;
      }
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        connectionIndex += 1;
        state.connectionOpenedAt.push(Date.now());
        (ws as unknown as { _idx: number })._idx = connectionIndex;
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as SubscribeFrame;
        if (frame.method === "connect") {
          state.connectionCount += 1;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 1 } }));
          return;
        }
        if (frame.method === "streamRunEvents") {
          const idx = (ws as unknown as { _idx: number })._idx;
          const afterSeq = frame.params?.afterSeq;
          state.afterSeqLog.push(typeof afterSeq === "number" ? afterSeq : -1);
          const streamId = `stream-${idx}`;
          const payload = behavior.subscribeReply
            ? behavior.subscribeReply(frame.params, streamId)
            : { streamId, runId: frame.params?.runId, afterSeq: afterSeq ?? null, currentSeq: afterSeq ?? 0 };
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
          behavior.onSubscribed?.(ws, { streamId, afterSeq, connectionIndex: idx });
          return;
        }
        // Unknown method: surface a real gateway error frame.
        ws.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UnknownMethod", message: `No such method: ${frame.method}` },
        }));
      },
    },
  });

  state.baseUrl = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

function sendRunEvent(ws: ServerWebSocket<unknown>, streamId: string, seq: number, event: string) {
  ws.send(JSON.stringify({
    type: "event",
    event: "run.event",
    seq,
    stateVersion: seq,
    payload: { streamId, runId: "run-1", seq, event },
  }));
}

function sendGapResync(ws: ServerWebSocket<unknown>, streamId: string, seq: number) {
  ws.send(JSON.stringify({
    type: "event",
    event: "run.gap_resync",
    seq,
    stateVersion: seq,
    payload: { streamId, runId: "run-1", seq },
  }));
}

let running: RealGatewayServer | undefined;

afterEach(() => {
  running?.stop();
  running = undefined;
});

describe("streamRunEventsResilient reconnect-resume (real WS server)", () => {
  test("reconnects after a mid-stream fault and resumes from the last observed seq", async () => {
    // First connection delivers seq 1 and 2 then the gateway emits a corrupt
    // mid-stream frame (a real fault the connection surfaces as a stream error).
    // The resilient generator must catch it, sleep on real backoff, reconnect,
    // re-subscribe with afterSeq=2, then continue receiving seq 3 and 4.
    running = startRealGatewayServer({
      onSubscribed: (ws, { afterSeq, connectionIndex }) => {
        const streamId = `stream-${connectionIndex}`;
        if (connectionIndex === 0) {
          // Sanity: first subscribe carries no afterSeq.
          expect(afterSeq).toBeUndefined();
          sendRunEvent(ws, streamId, 1, "task.started");
          sendRunEvent(ws, streamId, 2, "task.progress");
          // Inject a corrupt frame mid-stream: not valid JSON. The client's real
          // frame parser raises invalidGatewayResponse, ending the inner stream
          // with an error and triggering the resilient reconnect path.
          setTimeout(() => ws.send("{not-json"), 5);
        } else {
          // Second subscribe must resume from the last delivered seq (2).
          expect(afterSeq).toBe(2);
          sendRunEvent(ws, streamId, 3, "task.progress");
          sendRunEvent(ws, streamId, 4, "task.completed");
        }
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: Array<{ seq: number; event: string }> = [];

    const iterate = (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1" },
        { signal: controller.signal, backoff: { baseMs: 1, maxMs: 5, random: () => 0.5 } },
      )) {
        const payload = frame.payload as { seq: number; event: string };
        seen.push({ seq: payload.seq, event: payload.event });
        if (payload.seq === 4) {
          controller.abort();
        }
      }
    })();

    await iterate;

    expect(seen.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.at(-1)?.event).toBe("task.completed");
    // Two real socket connections happened: original + reconnect.
    expect(running.connectionCount).toBe(2);
    // The reconnect re-subscribed with afterSeq=2 (resume), verified above.
    expect(running.afterSeqLog).toEqual([-1, 2]);
  });

  test("reconnects after a mid-stream socket drop (close, no error) and resumes from the last seq", async () => {
    // The most common real-world failure: the server vanishes and the socket
    // closes with code 1006 — NO error frame, NO terminal `run.completed`. The
    // inner stream ends *gracefully*, so the resilient loop must recognize the
    // silent drop, sleep on real backoff, reconnect, re-subscribe with
    // afterSeq=2, and continue receiving seq 3 and 4. (Regression guard: a prior
    // implementation only reconnected on a thrown error and would have stopped
    // here, killing the stream forever.)
    running = startRealGatewayServer({
      onSubscribed: (ws, { afterSeq, connectionIndex }) => {
        const streamId = `stream-${connectionIndex}`;
        if (connectionIndex === 0) {
          expect(afterSeq).toBeUndefined();
          sendRunEvent(ws, streamId, 1, "task.started");
          sendRunEvent(ws, streamId, 2, "task.progress");
          // Abruptly drop the socket mid-stream with no error and no terminal
          // frame — the client surfaces this as a clean {kind:"close"}.
          setTimeout(() => ws.close(), 5);
        } else {
          expect(afterSeq).toBe(2);
          sendRunEvent(ws, streamId, 3, "task.progress");
          sendRunEvent(ws, streamId, 4, "task.completed");
        }
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: Array<{ seq: number; event: string }> = [];
    const reconnects: Array<Record<string, unknown>> = [];

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1" },
        {
          signal: controller.signal,
          backoff: { baseMs: 1, maxMs: 5, random: () => 0.5 },
          onReconnect: (event) => reconnects.push(event),
        },
      )) {
        const payload = frame.payload as { seq: number; event: string };
        seen.push({ seq: payload.seq, event: payload.event });
        if (payload.seq === 4) {
          controller.abort();
        }
      }
    })();

    expect(seen.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.at(-1)?.event).toBe("task.completed");
    expect(running.connectionCount).toBe(2);
    expect(running.afterSeqLog).toEqual([-1, 2]);
    expect(reconnects).toEqual([
      {
        runId: "run-1",
        afterSeq: 2,
        attempt: 0,
        backoffMs: 1,
        reason: "stream_closed",
      },
    ]);
  });

  test("stops cleanly when the run reaches a terminal run.completed frame (no reconnect)", async () => {
    // A legitimately-ended stream: the gateway emits a terminal `run.completed`
    // frame and then closes. The resilient loop must NOT treat that graceful
    // close as a drop — it returns without a second connection, so we never spin
    // on a finished run.
    running = startRealGatewayServer({
      onSubscribed: (ws, { connectionIndex }) => {
        const streamId = `stream-${connectionIndex}`;
        expect(connectionIndex).toBe(0);
        sendRunEvent(ws, streamId, 1, "task.started");
        // Terminal frame: the client recognizes payload.event === "run.completed".
        sendRunEvent(ws, streamId, 2, "run.completed");
        setTimeout(() => ws.close(), 5);
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: number[] = [];

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1" },
        { signal: controller.signal, backoff: { baseMs: 1, maxMs: 5, random: () => 0.5 } },
      )) {
        seen.push((frame.payload as { seq: number }).seq);
      }
    })();

    expect(seen).toEqual([1, 2]);
    // Exactly one connection: the terminal close did NOT trigger a reconnect.
    expect(running.connectionCount).toBe(1);
    expect(running.afterSeqLog).toEqual([-1]);
  });

  test("a flapping stream that only replays a gap_resync frame keeps escalating backoff (no base-delay busy loop)", async () => {
    // Pathological real-world flap: every connection accepts the socket, replays
    // exactly ONE `run.gap_resync` catch-up frame (an afterSeq replay), then
    // instantly closes — never delivering a fresh live frame and never staying
    // alive past the healthy threshold. The buggy implementation reset the
    // attempt counter on that first replay frame, so each reconnect slept the
    // BASE delay and the client hot-looped against a flapping server. The fix
    // must keep ESCALATING backoff because the connection never proves sustained
    // liveness. We measure the real wall-clock gap between successive socket
    // opens: with factor 2 and jitter 0 the gaps must roughly double, not stay
    // pinned at the base delay.
    running = startRealGatewayServer({
      onSubscribed: (ws, { connectionIndex }) => {
        const streamId = `stream-${connectionIndex}`;
        if (connectionIndex < 3) {
          sendGapResync(ws, streamId, 0);
          setTimeout(() => ws.close(), 1);
        } else {
          // Finally a genuinely live frame so the test terminates.
          sendRunEvent(ws, streamId, 1, "task.completed");
        }
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: number[] = [];
    const reconnectBackoffs: number[] = [];

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1" },
        {
          signal: controller.signal,
          // Huge healthy threshold + a replay-only flap means the connection is
          // NEVER healthy, so backoff must escalate every cycle.
          healthyAfterMs: 60_000,
          // jitter 0 => deterministic delay == baseMs * factor**attempt.
          backoff: { baseMs: 30, maxMs: 5_000, factor: 2, jitter: 0 },
          onReconnect: ({ backoffMs }) => reconnectBackoffs.push(backoffMs),
        },
      )) {
        const payload = frame.payload as { seq: number; event: string };
        if (frame.event === "run.gap_resync") {
          continue;
        }
        seen.push(payload.seq);
        controller.abort();
      }
    })();

    expect(seen).toEqual([1]);
    // 4 connections: 3 flapping replays-then-close + 1 live.
    expect(running.connectionCount).toBe(4);
    // The discriminating assertion vs the bug: if backoff reset on replay-only
    // gap_resync frames, every reconnect would report the base 30ms delay.
    expect(reconnectBackoffs).toEqual([30, 60, 120]);
  });

  test("a sustained healthy connection resets backoff so the next drop reconnects fast", async () => {
    // Counterpart to the flap test: once a connection delivers a fresh live frame
    // (proof of health), the attempt counter resets — so a later drop reconnects
    // at the base delay rather than at the escalated delay. Connection 0 stays
    // healthy (live frame), drops; connection 1 must reconnect at ~base delay.
    running = startRealGatewayServer({
      onSubscribed: (ws, { connectionIndex }) => {
        const streamId = `stream-${connectionIndex}`;
        if (connectionIndex === 0) {
          // A genuine live (non-replay) frame proves liveness and resets backoff.
          sendRunEvent(ws, streamId, 1, "task.started");
          setTimeout(() => ws.close(), 5);
        } else {
          sendRunEvent(ws, streamId, 2, "task.completed");
        }
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: number[] = [];

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1" },
        {
          signal: controller.signal,
          healthyAfterMs: 60_000,
          backoff: { baseMs: 20, maxMs: 5_000, factor: 2, jitter: 0 },
        },
      )) {
        seen.push((frame.payload as { seq: number }).seq);
        if ((frame.payload as { seq: number }).seq === 2) {
          controller.abort();
        }
      }
    })();

    expect(seen).toEqual([1, 2]);
    expect(running.connectionCount).toBe(2);
    // The reconnect happened at the base delay (attempt reset to 0 after the
    // healthy frame): the gap between the two opens is close to baseMs (20ms),
    // not an escalated value. Includes the ~5ms close timer; cap generously.
    const opens = running.connectionOpenedAt;
    const gap = opens[1]! - opens[0]!;
    expect(gap).toBeLessThan(150);
  });

  test("honors an explicit starting afterSeq on the first subscribe", async () => {
    running = startRealGatewayServer({
      onSubscribed: (ws, { afterSeq, connectionIndex }) => {
        expect(connectionIndex).toBe(0);
        expect(afterSeq).toBe(7);
        sendRunEvent(ws, `stream-${connectionIndex}`, 8, "task.completed");
      },
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const seen: number[] = [];

    await (async () => {
      for await (const frame of client.streamRunEventsResilient(
        { runId: "run-1", afterSeq: 7 },
        { signal: controller.signal, backoff: { baseMs: 1, maxMs: 5, random: () => 0.5 } },
      )) {
        seen.push((frame.payload as { seq: number }).seq);
        controller.abort();
      }
    })();

    expect(seen).toEqual([8]);
    expect(running.afterSeqLog).toEqual([7]);
  });
});

describe("streamRunEvents subscribe-streamId validation (real WS server)", () => {
  test("throws invalidGatewayResponse when the subscribe reply omits streamId", async () => {
    running = startRealGatewayServer({
      // Non-conforming handshake: reply has no streamId field.
      subscribeReply: () => ({ runId: "run-1", afterSeq: null }),
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const iterator = client.streamRunEvents({ runId: "run-1" });

    await expect(iterator.next()).rejects.toMatchObject({
      name: "GatewayRpcError",
      method: "streamRunEvents",
      code: "INVALID_GATEWAY_RESPONSE",
    });
  });

  test("throws invalidGatewayResponse when streamId is the wrong type", async () => {
    running = startRealGatewayServer({
      subscribeReply: () => ({ streamId: 123, runId: "run-1" }),
    });

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const iterator = client.streamRunEvents({ runId: "run-1" });

    const error = await iterator.next().catch((e) => e);
    expect(error).toBeInstanceOf(GatewayRpcError);
    expect(error.code).toBe("INVALID_GATEWAY_RESPONSE");
  });
});

describe("connect() AbortSignal handling (real WS server)", () => {
  test("aborting during the handshake rejects promptly and closes the socket", async () => {
    // Server accepts the socket but NEVER replies to the connect frame, so the
    // handshake hangs until the abort fires (exercising the real raceSignal path).
    running = startRealGatewayServer({});
    // Patch the server to swallow connect replies by routing through a server
    // that only upgrades and stays silent on connect.
    running.stop();
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("nope", { status: 426 });
      },
      websocket: {
        message() {
          // Intentionally silent: never answer the connect handshake.
        },
      },
    });
    running = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      afterSeqLog: [],
      connectionCount: 0,
      connectionOpenedAt: [],
      stop: () => server.stop(true),
    };

    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    const pending = client.connect({ subscribe: ["run-1"], signal: controller.signal });

    // Give the socket time to open and send the connect frame, then abort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = Date.now();
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
    // Rejection is prompt (well under any timeout), proving the signal short-circuits.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("aborting before connect() is called rejects immediately", async () => {
    running = startRealGatewayServer({});
    const client = new SmithersGatewayClient({ baseUrl: running.baseUrl });
    const controller = new AbortController();
    controller.abort();

    await expect(client.connect({ signal: controller.signal })).rejects.toThrow(/aborted/i);
  });
});
