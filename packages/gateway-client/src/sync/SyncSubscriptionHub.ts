import type { SyncCache } from "./SyncCache.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint } from "./SyncKey.ts";
import type { SyncStreamFrame, SyncTransport } from "./SyncTransport.ts";
import { syncBackoffDelay, type SyncBackoffOptions } from "./SyncBackoff.ts";

/**
 * TRANSITIONAL SHIM. Kept exported so unmigrated consumers keep compiling while
 * they move onto TanStack DB collections (`createGatewayCollection`). See
 * `SyncClient.ts` for the migration note.
 *
 * Streaming subscriptions in Smithers are expensive — every WebSocket is one
 * round-trip + one server-side journal cursor. The hub multiplexes any number
 * of observers onto a single underlying stream per key. Responsibilities:
 *
 *  - ref-counted streams: first subscriber opens the stream, last unsubscribe
 *    closes it
 *  - lastSeq tracking: each live channel remembers the latest `seq` so
 *    reconnect resumes at `afterSeq = lastSeq` without leaking cache entries
 *  - reconnect with backoff on TRANSIENT failures (thrown error): graceful
 *    end of the async iterable is treated as terminal so a resilient transport
 *    (e.g. `SmithersGatewayClient.streamRunEventsResilient` returning on
 *    `run.completed`) does not get re-spawned forever
 *  - backpressure: each subscriber holds a bounded ring; bursts past `bufferMax`
 *    drop the oldest frame and bump a `dropped` counter, so a slow consumer
 *    can't memory-pin the whole UI
 *  - auth bail-out: an `UNAUTHORIZED` error short-circuits the reconnect loop
 *    and surfaces via `onAuthError`, so we don't hammer the gateway with a
 *    rejected token
 */

export type SyncSubscriptionListener = (frame: SyncStreamFrame) => void;

export type SyncSubscriptionOptions = {
  /** Per-subscriber ring buffer size. Default 1024. */
  bufferMax?: number;
  /** Backoff curve seam. */
  backoff?: SyncBackoffOptions;
  /** Notified when the transport rejects with an UNAUTHORIZED-shaped error. */
  onAuthError?: (error: Error) => void;
  /** Notified when a recoverable error occurs (drop, network blip). */
  onTransportError?: (error: Error) => void;
  /** Sleep seam for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Logger seam; only diagnostic, not for user-visible errors. */
  log?: (level: "info" | "warn", message: string, details?: unknown) => void;
  /**
   * Default false: the hub treats a graceful end of the async iterable as
   * terminal and does NOT reconnect. Set true for raw transports that cannot
   * distinguish a 1006 socket drop from a clean end and need the hub to handle
   * reconnection itself; the channel's `lastSeq` is still passed as `afterSeq`
   * on each reconnect.
   */
  reconnectOnGracefulEnd?: boolean;
};

type Channel = {
  key: SyncKey;
  keyFingerprint: string;
  fingerprint: string;
  scope: string;
  params: unknown;
  lastSeq: number | undefined;
  listeners: Map<SyncSubscriptionListener, RingBuffer>;
  abort: AbortController;
  closed: boolean;
};

class RingBuffer {
  dropped = 0;
  private readonly slots: SyncStreamFrame[] = [];
  constructor(private readonly max: number) {}
  push(frame: SyncStreamFrame): void {
    if (this.slots.length >= this.max) {
      this.slots.shift();
      this.dropped += 1;
    }
    this.slots.push(frame);
  }
  drain(): SyncStreamFrame[] {
    const out = this.slots.slice();
    this.slots.length = 0;
    return out;
  }
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^(UNAUTHORIZED|Unauthorized|FORBIDDEN|Forbidden)\b/.test(message);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SyncSubscriptionHub {
  private readonly channels = new Map<string, Channel>();

  constructor(
    _cache: SyncCache,
    private readonly transport: SyncTransport,
    private readonly options: SyncSubscriptionOptions = {},
  ) {}

  /**
   * Subscribe to the stream for `key` (opening a transport stream on the first
   * subscriber). Returns an unsubscribe that decrements the channel's refcount
   * and closes the upstream when the last observer departs.
   */
  subscribe(
    key: SyncKey,
    scope: string,
    params: unknown,
    listener: SyncSubscriptionListener,
  ): () => void {
    if (typeof this.transport.stream !== "function") {
      throw new Error("Transport does not support stream subscriptions.");
    }
    const keyFingerprint = syncKeyFingerprint(key);
    const fingerprint = syncKeyFingerprint(this.channelKey(key, scope, params));
    let channel = this.channels.get(fingerprint);
    if (!channel) {
      channel = {
        key,
        keyFingerprint,
        fingerprint,
        scope,
        params,
        lastSeq: undefined,
        listeners: new Map(),
        abort: new AbortController(),
        closed: false,
      };
      this.channels.set(fingerprint, channel);
      this.openLoop(channel);
    }
    const ring = new RingBuffer(this.options.bufferMax ?? 1024);
    channel.listeners.set(listener, ring);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const current = this.channels.get(fingerprint);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        current.closed = true;
        current.abort.abort();
        this.channels.delete(fingerprint);
      }
    };
  }

  /** Number of distinct observers on `key`. Exposed for tests. */
  observerCount(key: SyncKey): number {
    const keyFingerprint = syncKeyFingerprint(key);
    let count = 0;
    for (const channel of this.channels.values()) {
      if (channel.keyFingerprint === keyFingerprint) count += channel.listeners.size;
    }
    return count;
  }

  /** True if a channel is currently open for `key`. */
  isOpen(key: SyncKey): boolean {
    const keyFingerprint = syncKeyFingerprint(key);
    for (const channel of this.channels.values()) {
      if (channel.keyFingerprint === keyFingerprint && !channel.closed) return true;
    }
    return false;
  }

  /** Drop-count for `listener` since subscription start (backpressure stats). */
  droppedFor(key: SyncKey, listener: SyncSubscriptionListener): number {
    const keyFingerprint = syncKeyFingerprint(key);
    for (const channel of this.channels.values()) {
      if (channel.keyFingerprint !== keyFingerprint) continue;
      const ring = channel.listeners.get(listener);
      if (ring) return ring.dropped;
    }
    return 0;
  }

  /** Close every channel; used on hard logout / cache.clear(). */
  closeAll(): void {
    for (const channel of this.channels.values()) {
      channel.closed = true;
      channel.abort.abort();
    }
    this.channels.clear();
  }

  private channelKey(key: SyncKey, scope: string, params: unknown): SyncKey {
    return [...key, { streamScope: scope, streamParams: params }] as SyncKey;
  }

  private openLoop(channel: Channel): void {
    const sleep = this.options.sleep ?? defaultSleep;
    const reconnectOnGracefulEnd = this.options.reconnectOnGracefulEnd ?? false;
    void (async () => {
      let attempt = 0;
      while (!channel.closed) {
        let threw = false;
        try {
          const iterable = this.transport.stream!(channel.scope, channel.params, {
            signal: channel.abort.signal,
            afterSeq: channel.lastSeq,
          });
          for await (const frame of iterable) {
            if (channel.closed) return;
            attempt = 0;
            if (typeof frame.seq === "number") {
              if (channel.lastSeq === undefined || frame.seq > channel.lastSeq) {
                channel.lastSeq = frame.seq;
              }
            }
            for (const [listener, ring] of channel.listeners) {
              try {
                listener(frame);
              } catch (cause) {
                // A consumer threw mid-frame: park the frame on its ring so a
                // future retry sees it instead of dropping silently. We still
                // continue delivering to other consumers.
                ring.push(frame);
                this.options.log?.("warn", "sync subscriber threw", cause);
              }
            }
          }
          if (channel.closed) return;
          // Graceful end of the async iterable. Resilient transports (e.g.
          // streamRunEventsResilient) return cleanly when the run hits a
          // terminal state; treating that as a drop would loop forever. Raw
          // transports that need the hub to reconnect can opt in via
          // `reconnectOnGracefulEnd: true`.
          if (!reconnectOnGracefulEnd) {
            channel.closed = true;
            this.channels.delete(channel.fingerprint);
            return;
          }
          attempt += 1;
        } catch (cause) {
          threw = true;
          if (channel.closed) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (isAuthError(error)) {
            this.options.onAuthError?.(error);
            channel.closed = true;
            this.channels.delete(channel.fingerprint);
            return;
          }
          this.options.onTransportError?.(error);
          attempt += 1;
        }
        if (channel.closed) return;
        // Either the iterable threw (always reconnect with backoff) or it
        // ended gracefully and we opted into reconnect-on-end.
        if (!threw && !reconnectOnGracefulEnd) return;
        await sleep(syncBackoffDelay(attempt, this.options.backoff), channel.abort.signal);
      }
    })();
  }
}
