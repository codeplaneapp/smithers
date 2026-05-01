import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { loadBudget } from "../budgets/loadBudget.ts";

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
  db.exec("BEGIN");
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    insert.run(runId, seq, baseTs + seq, "node.event", JSON.stringify({ runId, seq }));
  }
  db.exec("COMMIT");
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
  return new Promise((resolveServer, rejectServer) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.once("error", rejectServer);
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
      resolveServer({
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

async function connectAndSubscribe(port: number, runId: string): Promise<FrameCollector> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => resolveOpen());
    ws.once("error", rejectOpen);
  });
  const frames: ServerFrame[] = [];
  let resolveStop!: () => void;
  const ended = new Promise<void>((res) => {
    resolveStop = res;
  });
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as ServerFrame;
    frames.push(frame);
    if (frame.type === "end") resolveStop();
  });
  ws.on("close", () => resolveStop());
  const subscribe: SubscribeRequest = { type: "subscribe", runId };
  ws.send(JSON.stringify(subscribe));
  return { ws, frames, ended };
}

function tryGc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  if (typeof bunGc === "function") bunGc(true);
}

describe("case 16: N=5 subscribers on one run; bounded memory; consistent state", () => {
  test("five concurrent subscribers see identical seq sets in order, peak RSS under budget", async () => {
    const budget = (await loadBudget("memory")) as {
      subscriberFanoutN5: { rssBytesMax: number };
    };
    const rssBudget = budget.subscriberFanoutN5.rssBytesMax;

    const db = buildDb();
    let server: SubscriberServer | undefined;
    const sockets: WebSocket[] = [];
    const runId = "case16-run";
    const eventCount = 500;
    const subscriberCount = 5;
    try {
      insertEvents(db, runId, eventCount);
      server = await startSubscriberServer(db);

      tryGc();
      const baselineRss = process.memoryUsage().rss;

      const subscribers = await Promise.all(
        Array.from({ length: subscriberCount }, () => connectAndSubscribe(server!.port, runId)),
      );
      for (const s of subscribers) sockets.push(s.ws);

      let peakRss = baselineRss;
      const sampleInterval = setInterval(() => {
        const current = process.memoryUsage().rss;
        if (current > peakRss) peakRss = current;
      }, 5);

      try {
        await Promise.all(subscribers.map((s) => s.ended));
      } finally {
        clearInterval(sampleInterval);
      }

      const finalRss = process.memoryUsage().rss;
      if (finalRss > peakRss) peakRss = finalRss;

      const seqsPerSubscriber = subscribers.map((s) =>
        s.frames.filter((f): f is EventFrame => f.type === "event").map((f) => f.seq),
      );

      for (const seqs of seqsPerSubscriber) {
        expect(seqs.length).toBe(eventCount);
        for (let i = 1; i < seqs.length; i += 1) {
          expect(seqs[i]).toBe(seqs[i - 1]! + 1);
        }
        expect(seqs[0]).toBe(0);
        expect(seqs[seqs.length - 1]).toBe(eventCount - 1);
      }

      const expectedSet = new Set<number>();
      for (let i = 0; i < eventCount; i += 1) expectedSet.add(i);
      for (const seqs of seqsPerSubscriber) {
        expect(new Set(seqs)).toEqual(expectedSet);
      }

      for (const s of subscribers) {
        const endFrame = s.frames.find((f) => f.type === "end") as EndFrame | undefined;
        expect(endFrame).toBeDefined();
        expect(endFrame!.lastSeq).toBe(eventCount - 1);
      }

      expect(peakRss).toBeLessThan(rssBudget);

      const delta = peakRss - baselineRss;
      expect(delta).toBeGreaterThanOrEqual(0);
    } finally {
      for (const ws of sockets) {
        if (ws.readyState !== ws.CLOSED) ws.terminate();
      }
      if (server) await server.close();
      db.close();
    }
  });
});
