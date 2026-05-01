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

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";
const DEFAULT_DURATION_MS = 10 * 60_000;
const HARD_CEILING_MS = 12 * 60_000;
const EVENTS_PER_SECOND = 10;
const SAMPLE_INTERVAL_MS = 5_000;
const GC_INTERVAL_MS = 30_000;
const PAYLOAD_BYTES = 200;

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

function makePayload(seq: number): string {
  const filler = "x".repeat(Math.max(0, PAYLOAD_BYTES - 40));
  return JSON.stringify({ seq, filler });
}

function insertEvent(db: Database, runId: string, seq: number): void {
  db.query(
    "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
  ).run(runId, seq, Date.now(), "node.event", makePayload(seq));
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
  broadcast: (row: EventRow) => void;
  close: () => Promise<void>;
};

function startSubscriberServer(db: Database): Promise<SubscriberServer> {
  return new Promise((resolveServer, rejectServer) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const liveSubs = new Set<{ ws: WebSocket; runId: string }>();
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
          }
          liveSubs.add({ ws, runId: req.runId });
        });
        ws.on("close", () => {
          for (const sub of liveSubs) {
            if (sub.ws === ws) liveSubs.delete(sub);
          }
        });
      });
      const address = wss.address() as AddressInfo;
      resolveServer({
        port: address.port,
        broadcast: (row) => {
          const frame: EventFrame = {
            type: "event",
            runId: row.run_id,
            seq: Number(row.seq),
            timestampMs: Number(row.timestamp_ms),
            eventType: row.type,
            payloadJson: row.payload_json,
          };
          const encoded = JSON.stringify(frame);
          for (const sub of liveSubs) {
            if (sub.runId !== row.run_id) continue;
            if (sub.ws.readyState === sub.ws.OPEN) sub.ws.send(encoded);
          }
        },
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

type LiveCollector = {
  ws: WebSocket;
  receivedCount: number;
  gaps: number;
  lastSeq: number;
  close: () => void;
};

async function connectLive(port: number, runId: string): Promise<LiveCollector> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => resolveOpen());
    ws.once("error", rejectOpen);
  });
  const collector: LiveCollector = {
    ws,
    receivedCount: 0,
    gaps: 0,
    lastSeq: -1,
    close: () => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    },
  };
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as ServerFrame;
    if (frame.type !== "event") return;
    if (frame.seq !== collector.lastSeq + 1) collector.gaps += 1;
    collector.lastSeq = frame.seq;
    collector.receivedCount += 1;
  });
  const subscribe: SubscribeRequest = { type: "subscribe", runId, afterSeq: -1 };
  ws.send(JSON.stringify(subscribe));
  return collector;
}

function tryGc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
  if (typeof bunGc === "function") bunGc(true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe("case 28: 10+ min live stream on busy run; RSS within budget", () => {
  test.skipIf(!SOAK_ENABLED)(
    "single subscriber on busy live stream keeps peak RSS under liveStream10min budget",
    async () => {
      const overrideRaw = process.env.SMITHERS_E2E_SOAK_DURATION_MS;
      const overrideMs = overrideRaw ? Number.parseInt(overrideRaw, 10) : NaN;
      const durationMs =
        Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : DEFAULT_DURATION_MS;
      const wallCeilingMs = Math.min(HARD_CEILING_MS, durationMs + 2 * 60_000);

      const budget = (await loadBudget("memory")) as {
        liveStream10min: { rssBytesMax: number };
      };
      const rssBudget = budget.liveStream10min.rssBytesMax;

      const db = buildDb();
      let server: SubscriberServer | undefined;
      let collector: LiveCollector | undefined;
      const runId = "case28-run";
      const intervalMs = 1000 / EVENTS_PER_SECOND;

      try {
        server = await startSubscriberServer(db);
        collector = await connectLive(server.port, runId);

        tryGc();
        const baselineRss = process.memoryUsage().rss;
        let peakRss = baselineRss;

        const start = Date.now();
        let nextSeq = 0;

        const sampleHandle = setInterval(() => {
          const current = process.memoryUsage().rss;
          if (current > peakRss) peakRss = current;
        }, SAMPLE_INTERVAL_MS);

        const gcHandle = setInterval(() => tryGc(), GC_INTERVAL_MS);

        const emitHandle = setInterval(() => {
          insertEvent(db, runId, nextSeq);
          const rows = readEventsAfter(db, runId, nextSeq - 1);
          const row = rows[rows.length - 1];
          if (row) server!.broadcast(row);
          nextSeq += 1;
        }, intervalMs);

        try {
          while (Date.now() - start < durationMs) {
            await sleep(250);
            if (Date.now() - start > wallCeilingMs) break;
          }
        } finally {
          clearInterval(emitHandle);
          clearInterval(gcHandle);
          clearInterval(sampleHandle);
        }

        await sleep(500);

        const finalRss = process.memoryUsage().rss;
        if (finalRss > peakRss) peakRss = finalRss;

        const expectedMin = Math.floor(durationMs / intervalMs * 0.5);
        expect(nextSeq).toBeGreaterThanOrEqual(expectedMin);
        expect(collector.receivedCount).toBeGreaterThanOrEqual(expectedMin);
        expect(collector.gaps).toBe(0);
        expect(collector.lastSeq).toBe(collector.receivedCount - 1);

        const elapsedMs = Date.now() - start;
        // eslint-disable-next-line no-console
        console.log(
          `[case28] duration=${elapsedMs}ms emitted=${nextSeq} received=${collector.receivedCount} baselineRss=${baselineRss} peakRss=${peakRss} budget=${rssBudget}`,
        );

        expect(peakRss).toBeLessThan(rssBudget);
      } finally {
        if (collector) collector.close();
        if (server) await server.close();
        db.close();
      }
    },
    HARD_CEILING_MS + 60_000,
  );
});
