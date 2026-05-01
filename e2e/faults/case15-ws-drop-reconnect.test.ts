import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { dropWebSocket } from "../harness/dropWebSocket.ts";

type EventRow = {
  run_id: string;
  seq: number;
  timestamp_ms: number;
  type: string;
  payload_json: string;
};

type ConnectRequest = {
  type: "connect";
  auth: { token: string };
};

type StreamRunEventsRequest = {
  type: "streamRunEvents";
  runId: string;
  afterSeq?: number;
};

type ClientFrame = ConnectRequest | StreamRunEventsRequest;

type ConnectAckFrame = {
  type: "connect.ack";
  auth: { userId: string; role: string };
};

type ConnectErrorFrame = {
  type: "connect.error";
  code: "UNAUTHORIZED";
  message: string;
};

type StreamOpenFrame = {
  type: "stream.open";
  streamId: string;
  runId: string;
  afterSeq: number | null;
  currentSeq: number;
};

type EventFrame = {
  type: "event";
  streamId: string;
  runId: string;
  seq: number;
  timestampMs: number;
  eventType: string;
  payloadJson: string;
};

type EndFrame = {
  type: "end";
  streamId: string;
  runId: string;
  lastSeq: number;
};

type ServerFrame = ConnectAckFrame | ConnectErrorFrame | StreamOpenFrame | EventFrame | EndFrame;

type AuthRecord = { userId: string; role: string; scopes: string[] };

const TOKENS: Record<string, AuthRecord> = {
  "op-token": { userId: "user:will", role: "operator", scopes: ["*"] },
};

function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `);
  return db;
}

function insertEvents(db: Database, runId: string, count: number, startSeq = 0): void {
  const insert = db.query(
    "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
  );
  const baseTs = Date.now();
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    insert.run(runId, seq, baseTs + seq, "node.event", JSON.stringify({ runId, seq }));
  }
}

function readEventsAfter(db: Database, runId: string, afterSeq: number): EventRow[] {
  return db
    .query(
      "SELECT run_id, seq, timestamp_ms, type, payload_json FROM _smithers_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(runId, afterSeq) as EventRow[];
}

function currentSeqFor(db: Database, runId: string): number {
  const row = db
    .query("SELECT MAX(seq) AS maxSeq FROM _smithers_events WHERE run_id = ?")
    .get(runId) as { maxSeq: number | null } | undefined;
  return row && typeof row.maxSeq === "number" ? row.maxSeq : -1;
}

type GatewayObservations = {
  serverCloseCodes: number[];
};

type GatewayServer = {
  port: number;
  observations: GatewayObservations;
  close: () => Promise<void>;
};

function startStreamingGateway(db: Database): Promise<GatewayServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const observations: GatewayObservations = { serverCloseCodes: [] };
    let nextStreamId = 1;
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.on("connection", (ws) => {
        let auth: AuthRecord | null = null;
        ws.on("close", (code) => {
          observations.serverCloseCodes.push(code);
        });
        ws.on("message", (raw) => {
          let frame: ClientFrame;
          try {
            frame = JSON.parse(String(raw)) as ClientFrame;
          } catch {
            return;
          }
          if (frame.type === "connect") {
            const record = TOKENS[frame.auth?.token ?? ""];
            if (!record) {
              const err: ConnectErrorFrame = {
                type: "connect.error",
                code: "UNAUTHORIZED",
                message: "invalid bearer token",
              };
              ws.send(JSON.stringify(err));
              ws.close(4401);
              return;
            }
            auth = record;
            const ack: ConnectAckFrame = {
              type: "connect.ack",
              auth: { userId: record.userId, role: record.role },
            };
            ws.send(JSON.stringify(ack));
            return;
          }
          if (frame.type === "streamRunEvents") {
            if (!auth) {
              const err: ConnectErrorFrame = {
                type: "connect.error",
                code: "UNAUTHORIZED",
                message: "must connect first",
              };
              ws.send(JSON.stringify(err));
              ws.close(4401);
              return;
            }
            const afterSeq = typeof frame.afterSeq === "number" ? frame.afterSeq : -1;
            const streamId = `stream_${nextStreamId++}`;
            const open: StreamOpenFrame = {
              type: "stream.open",
              streamId,
              runId: frame.runId,
              afterSeq: typeof frame.afterSeq === "number" ? frame.afterSeq : null,
              currentSeq: currentSeqFor(db, frame.runId),
            };
            ws.send(JSON.stringify(open));
            const rows = readEventsAfter(db, frame.runId, afterSeq);
            let lastSeq = afterSeq;
            for (const row of rows) {
              if (ws.readyState !== ws.OPEN) return;
              const ev: EventFrame = {
                type: "event",
                streamId,
                runId: row.run_id,
                seq: Number(row.seq),
                timestampMs: Number(row.timestamp_ms),
                eventType: row.type,
                payloadJson: row.payload_json,
              };
              ws.send(JSON.stringify(ev));
              lastSeq = ev.seq;
            }
            if (ws.readyState === ws.OPEN) {
              const end: EndFrame = { type: "end", streamId, runId: frame.runId, lastSeq };
              ws.send(JSON.stringify(end));
            }
          }
        });
      });
      const address = wss.address() as AddressInfo;
      resolve({
        port: address.port,
        observations,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) {
              try {
                client.terminate();
              } catch {
                // ignore
              }
            }
            wss.close();
            res();
          }),
      });
    });
  });
}

type StreamCollector = {
  ws: WebSocket;
  frames: ServerFrame[];
  ended: Promise<void>;
};

async function connectAuthedAndStream(
  port: number,
  token: string,
  runId: string,
  afterSeq: number | undefined,
  stopAfter: number | null,
): Promise<StreamCollector> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const frames: ServerFrame[] = [];
  let resolveStop!: () => void;
  const ended = new Promise<void>((res) => {
    resolveStop = res;
  });
  let connected = false;
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "connect.ack" && !connected) {
      connected = true;
      const sub: StreamRunEventsRequest = { type: "streamRunEvents", runId };
      if (typeof afterSeq === "number") sub.afterSeq = afterSeq;
      ws.send(JSON.stringify(sub));
      return;
    }
    if (frame.type === "connect.error") {
      resolveStop();
      return;
    }
    if (frame.type === "end") {
      resolveStop();
      return;
    }
    if (stopAfter !== null && frame.type === "event" && frame.seq >= stopAfter) {
      resolveStop();
    }
  });
  ws.on("close", () => resolveStop());
  const connect: ConnectRequest = { type: "connect", auth: { token } };
  ws.send(JSON.stringify(connect));
  return { ws, frames, ended };
}

describe("case 15: drop authenticated streamRunEvents mid-stream, reconnect with afterSeq", () => {
  test("abrupt drop mid-stream then reconnect with afterSeq replays without gap or dup over 100+ events", async () => {
    const db = buildDb();
    let server: GatewayServer | undefined;
    let firstWs: WebSocket | undefined;
    let secondWs: WebSocket | undefined;
    const runId = "case15-run";
    const initialCount = 60;
    const interruptAfterSeq = 30;
    const tailCount = 70;
    try {
      insertEvents(db, runId, initialCount);
      server = await startStreamingGateway(db);

      const first = await connectAuthedAndStream(
        server.port,
        "op-token",
        runId,
        undefined,
        interruptAfterSeq,
      );
      firstWs = first.ws;
      await first.ended;

      const ack = first.frames.find((f) => f.type === "connect.ack") as
        | ConnectAckFrame
        | undefined;
      expect(ack).toBeDefined();
      expect(ack!.auth.userId).toBe("user:will");

      const open = first.frames.find((f) => f.type === "stream.open") as
        | StreamOpenFrame
        | undefined;
      expect(open).toBeDefined();
      expect(open!.runId).toBe(runId);
      expect(open!.currentSeq).toBe(initialCount - 1);

      const firstSeqs = first.frames
        .filter((f): f is EventFrame => f.type === "event")
        .map((f) => f.seq);
      expect(firstSeqs.length).toBeGreaterThan(0);
      expect(firstSeqs[0]).toBe(0);
      const firstLastSeq = firstSeqs[firstSeqs.length - 1]!;
      expect(firstLastSeq).toBeGreaterThanOrEqual(interruptAfterSeq);
      for (let i = 1; i < firstSeqs.length; i += 1) {
        expect(firstSeqs[i]).toBe(firstSeqs[i - 1]! + 1);
      }

      await dropWebSocket(firstWs, "abrupt");
      expect(firstWs.readyState).toBe(firstWs.CLOSED);

      await new Promise<void>((res) => setTimeout(res, 10));
      expect(server.observations.serverCloseCodes.length).toBeGreaterThan(0);
      expect(server.observations.serverCloseCodes[0]).toBe(1006);

      insertEvents(db, runId, tailCount, initialCount);

      const second = await connectAuthedAndStream(
        server.port,
        "op-token",
        runId,
        firstLastSeq,
        null,
      );
      secondWs = second.ws;
      await second.ended;

      const secondSeqs = second.frames
        .filter((f): f is EventFrame => f.type === "event")
        .map((f) => f.seq);
      expect(secondSeqs.length).toBe(initialCount + tailCount - 1 - firstLastSeq);
      expect(secondSeqs[0]).toBe(firstLastSeq + 1);
      for (let i = 1; i < secondSeqs.length; i += 1) {
        expect(secondSeqs[i]).toBe(secondSeqs[i - 1]! + 1);
      }

      const merged = [...firstSeqs, ...secondSeqs];
      const expectedTotal = initialCount + tailCount;
      expect(merged.length).toBeGreaterThanOrEqual(100);
      expect(merged.length).toBe(expectedTotal);
      expect(new Set(merged).size).toBe(expectedTotal);
      for (let i = 0; i < expectedTotal; i += 1) {
        expect(merged[i]).toBe(i);
      }

      const endFrame = second.frames.find((f) => f.type === "end") as EndFrame | undefined;
      expect(endFrame).toBeDefined();
      expect(endFrame!.lastSeq).toBe(expectedTotal - 1);
    } finally {
      if (firstWs && firstWs.readyState !== firstWs.CLOSED) firstWs.terminate();
      if (secondWs && secondWs.readyState !== secondWs.CLOSED) secondWs.terminate();
      if (server) await server.close();
      db.close();
    }
  });

  test("rejects streamRunEvents without authenticated connect", async () => {
    const db = buildDb();
    let server: GatewayServer | undefined;
    let ws: WebSocket | undefined;
    try {
      insertEvents(db, "case15-auth", 3);
      server = await startStreamingGateway(db);

      ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve, reject) => {
        ws!.once("open", () => resolve());
        ws!.once("error", reject);
      });
      const errPromise = new Promise<ConnectErrorFrame>((resolve) => {
        ws!.on("message", (raw) => {
          const frame = JSON.parse(String(raw)) as ServerFrame;
          if (frame.type === "connect.error") resolve(frame);
        });
      });
      const bad: ConnectRequest = { type: "connect", auth: { token: "nope" } };
      ws.send(JSON.stringify(bad));
      const err = await errPromise;
      expect(err.code).toBe("UNAUTHORIZED");
    } finally {
      if (ws && ws.readyState !== ws.CLOSED) ws.terminate();
      if (server) await server.close();
      db.close();
    }
  });

  test.skip("real JWT validation against gateway streamRunEvents (see ticket 0022 §C row 14)", () => {
    // case 14 boots the real Gateway with mode:'jwt' and calls streamRunEvents.
    // Once that lands, this case can layer on top by importing its boot helper
    // instead of the bearer-token model used here.
  });
});
