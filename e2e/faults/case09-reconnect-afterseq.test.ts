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

type SubscribeRequest = {
  type: "subscribe";
  runId: string;
  afterSeq?: number;
};

type EventFrame = {
  type: "event";
  runId: string;
  seq: number;
  timestampMs: number;
  eventType: string;
  payloadJson: string;
};

type EndFrame = {
  type: "end";
  runId: string;
  lastSeq: number;
};

type ServerFrame = EventFrame | EndFrame;

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

type SubscriberServer = {
  port: number;
  close: () => Promise<void>;
};

function startSubscriberServer(db: Database): Promise<SubscriberServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.on("connection", (ws) => {
        ws.on("message", (raw) => {
          let req: SubscribeRequest;
          try {
            req = JSON.parse(String(raw)) as SubscribeRequest;
          } catch {
            return;
          }
          if (req.type !== "subscribe") return;
          const afterSeq = typeof req.afterSeq === "number" ? req.afterSeq : -1;
          const rows = readEventsAfter(db, req.runId, afterSeq);
          let lastSeq = afterSeq;
          for (const row of rows) {
            if (ws.readyState !== ws.OPEN) return;
            const frame: EventFrame = {
              type: "event",
              runId: row.run_id,
              seq: Number(row.seq),
              timestampMs: Number(row.timestamp_ms),
              eventType: row.type,
              payloadJson: row.payload_json,
            };
            ws.send(JSON.stringify(frame));
            lastSeq = frame.seq;
          }
          if (ws.readyState === ws.OPEN) {
            const end: EndFrame = { type: "end", runId: req.runId, lastSeq };
            ws.send(JSON.stringify(end));
          }
        });
      });
      const address = wss.address() as AddressInfo;
      resolve({
        port: address.port,
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

type FrameCollector = {
  ws: WebSocket;
  frames: ServerFrame[];
  ended: Promise<void>;
};

async function connectAndSubscribe(
  port: number,
  runId: string,
  afterSeq: number | undefined,
  stopAfter: number | null,
): Promise<FrameCollector> {
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
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "end") {
      resolveStop();
      return;
    }
    if (stopAfter !== null && frame.type === "event" && frame.seq >= stopAfter) {
      resolveStop();
    }
  });
  ws.on("close", () => resolveStop());
  const subscribe: SubscribeRequest = { type: "subscribe", runId };
  if (typeof afterSeq === "number") subscribe.afterSeq = afterSeq;
  ws.send(JSON.stringify(subscribe));
  return { ws, frames, ended };
}

describe("case 09: subscriber disconnect, reconnect with afterSeq", () => {
  test("disconnect mid-stream and reconnect with afterSeq replays without gap or dup", async () => {
    const db = buildDb();
    let server: SubscriberServer | undefined;
    let firstWs: WebSocket | undefined;
    let secondWs: WebSocket | undefined;
    const runId = "case09-run";
    const initialCount = 12;
    const interruptAfterSeq = 5;
    const tailCount = 8;
    try {
      insertEvents(db, runId, initialCount);
      server = await startSubscriberServer(db);

      const first = await connectAndSubscribe(server.port, runId, undefined, interruptAfterSeq);
      firstWs = first.ws;
      await first.ended;

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

      insertEvents(db, runId, tailCount, initialCount);

      const second = await connectAndSubscribe(server.port, runId, firstLastSeq, null);
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

  test("afterSeq=K returns exactly events with seq > K (contract)", async () => {
    const db = buildDb();
    let server: SubscriberServer | undefined;
    let ws: WebSocket | undefined;
    const runId = "case09-contract";
    const total = 20;
    const cutoff = 9;
    try {
      insertEvents(db, runId, total);
      server = await startSubscriberServer(db);

      const subscriber = await connectAndSubscribe(server.port, runId, cutoff, null);
      ws = subscriber.ws;
      await subscriber.ended;

      const seqs = subscriber.frames
        .filter((f): f is EventFrame => f.type === "event")
        .map((f) => f.seq);
      expect(seqs.length).toBe(total - 1 - cutoff);
      expect(seqs.every((s) => s > cutoff)).toBe(true);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBe(seqs[i - 1]! + 1);
      }
    } finally {
      if (ws && ws.readyState !== ws.CLOSED) ws.terminate();
      if (server) await server.close();
      db.close();
    }
  });

  test("afterSeq equal to current last seq yields zero replay events", async () => {
    const db = buildDb();
    let server: SubscriberServer | undefined;
    let ws: WebSocket | undefined;
    const runId = "case09-tip";
    const total = 4;
    try {
      insertEvents(db, runId, total);
      server = await startSubscriberServer(db);

      const subscriber = await connectAndSubscribe(server.port, runId, total - 1, null);
      ws = subscriber.ws;
      await subscriber.ended;

      const events = subscriber.frames.filter((f) => f.type === "event");
      expect(events.length).toBe(0);
      const endFrame = subscriber.frames.find((f) => f.type === "end") as EndFrame | undefined;
      expect(endFrame).toBeDefined();
      expect(endFrame!.lastSeq).toBe(total - 1);
    } finally {
      if (ws && ws.readyState !== ws.CLOSED) ws.terminate();
      if (server) await server.close();
      db.close();
    }
  });
});
