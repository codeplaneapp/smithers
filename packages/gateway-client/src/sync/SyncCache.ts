import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint, syncKeyMatches } from "./SyncKey.ts";

/**
 * TRANSITIONAL SHIM. Kept exported so unmigrated consumers keep compiling while
 * they move onto TanStack DB collections (`createGatewayCollection`). See
 * `SyncClient.ts` for the migration note.
 *
 * The in-memory cache that backs every query, mutation, and stream subscription
 * in the sync SDK. Responsibilities:
 *
 *  - typed key lookups (delegated to `SyncKey` / `syncKeyFingerprint`)
 *  - request dedupe — concurrent `fetch()`es for the same key share one promise
 *  - ref-counted observers — when the last observer leaves the entry GCs after
 *    `cacheTimeMs` (a typical query-cache trick that lets `useSyncQuery`
 *    survive route remounts without an immediate refetch)
 *  - stale-data guards — every fetch carries a generation; out-of-order
 *    responses for the same key are discarded
 *  - optimistic mutation hooks — `setData` records the prior snapshot so the
 *    caller can roll back on failure
 *  - last-seq tracking seam — consumers that need a cache-backed cursor can
 *    store a monotonic `lastSeq` without rewinding
 *  - versioned mutation counter — every notify-worthy change bumps `version`
 *    so React bindings backed by `useSyncExternalStore` see a fresh snapshot
 *    even though the entry object itself is mutated in place
 *
 * The cache is intentionally non-React: it's a vanilla store with a global
 * listener notification. React bindings subscribe via `useSyncExternalStore`.
 */

export type SyncCacheStatus = "idle" | "loading" | "success" | "error";

export type SyncCacheEntry<T = unknown> = {
  readonly key: SyncKey;
  readonly fingerprint: string;
  status: SyncCacheStatus;
  data: T | undefined;
  error: Error | undefined;
  /** When `data` was last written (ms). 0 if never set. */
  updatedAtMs: number;
  /** When the last successful fetch completed (ms). Used for stale checks. */
  fetchedAtMs: number;
  /** The most recent stream sequence the SDK has acknowledged. */
  lastSeq: number | undefined;
  /** Live observer count for ref-counting. 0 → entry is GC eligible. */
  observers: number;
  /** Monotonically increasing per-key generation for stale-response guards. */
  generation: number;
  /** In-flight promise for dedupe; cleared when settled. */
  promise: Promise<T> | undefined;
  /**
   * Monotonic version bumped on every notify. React `useSyncExternalStore`
   * bindings compare versions to decide whether to recompute their snapshot;
   * without this, an in-place mutation of `data` would not trigger a render
   * because the entry reference is unchanged.
   */
  version: number;
};

export type SyncCacheOptions = {
  /** How long unobserved entries linger before GC. Default 5 minutes. */
  cacheTimeMs?: number;
  /** A monotonic-ish clock seam for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Scheduler for delayed GC. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Cancel a previously scheduled GC. Defaults to clearTimeout. */
  clearTimer?: (handle: unknown) => void;
};

type Listener<T> = (entry: SyncCacheEntry<T>) => void;
type AnyListener = (entry: SyncCacheEntry) => void;

const DEFAULT_CACHE_TIME = 5 * 60_000;

export class SyncCache {
  private readonly entries = new Map<string, SyncCacheEntry>();
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly globals = new Set<AnyListener>();
  private readonly gcHandles = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly cacheTimeMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: SyncCacheOptions = {}) {
    this.cacheTimeMs = options.cacheTimeMs ?? DEFAULT_CACHE_TIME;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Return the entry for `key`, creating an idle one if it does not exist. */
  ensure<T>(key: SyncKey): SyncCacheEntry<T> {
    const fingerprint = syncKeyFingerprint(key);
    let entry = this.entries.get(fingerprint);
    if (!entry) {
      entry = {
        key,
        fingerprint,
        status: "idle",
        data: undefined,
        error: undefined,
        updatedAtMs: 0,
        fetchedAtMs: 0,
        lastSeq: undefined,
        observers: 0,
        generation: 0,
        promise: undefined,
        version: 0,
      };
      this.entries.set(fingerprint, entry);
    }
    return entry as SyncCacheEntry<T>;
  }

  /** Read-only peek; does not create an entry. */
  peek<T>(key: SyncKey): SyncCacheEntry<T> | undefined {
    return this.entries.get(syncKeyFingerprint(key)) as SyncCacheEntry<T> | undefined;
  }

  /**
   * Subscribe to changes for `key`. Increments observer count; the returned
   * unsubscribe decrements it and schedules a GC sweep once it hits zero.
   * Observers receive a synchronous initial notification so the consumer can
   * snapshot without a separate `peek()` call.
   */
  subscribe<T>(key: SyncKey, listener: Listener<T>): () => void {
    const entry = this.ensure<T>(key);
    entry.observers += 1;
    this.cancelGc(entry.fingerprint);
    let listeners = this.listeners.get(entry.fingerprint);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(entry.fingerprint, listeners);
    }
    listeners.add(listener as AnyListener);
    listener(entry);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const set = this.listeners.get(entry.fingerprint);
      if (set) {
        set.delete(listener as AnyListener);
        if (set.size === 0) this.listeners.delete(entry.fingerprint);
      }
      entry.observers = Math.max(0, entry.observers - 1);
      if (entry.observers === 0) {
        this.scheduleGc(entry.fingerprint);
      }
    };
  }

  /** Subscribe to *every* entry change. Used by stores that want one feed. */
  subscribeAll(listener: AnyListener): () => void {
    this.globals.add(listener);
    return () => {
      this.globals.delete(listener);
    };
  }

  /** Set data into an entry (e.g. optimistic mutation). Returns prior snapshot. */
  setData<T>(key: SyncKey, data: T): { previous: T | undefined; previousStatus: SyncCacheStatus } {
    const entry = this.ensure<T>(key);
    const previous = entry.data;
    const previousStatus = entry.status;
    entry.data = data;
    entry.status = "success";
    entry.error = undefined;
    entry.updatedAtMs = this.now();
    this.notify(entry);
    return { previous, previousStatus };
  }

  /**
   * Mark `key` (or every key matching `prefix`) as stale and refetch all
   * active entries via their last-known fetcher. An entry with zero observers
   * is left alone — there is no UI to refresh and the next subscribe will see
   * stale data and fetch.
   */
  invalidate(prefix: SyncKey, refetchFn?: (entry: SyncCacheEntry) => Promise<void>): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (!syncKeyMatches(entry.key, prefix)) continue;
      // Reset fetchedAt so isStale() returns true even when data is present.
      entry.fetchedAtMs = 0;
      this.notify(entry);
      if (entry.observers > 0 && refetchFn) {
        promises.push(refetchFn(entry).catch(() => undefined));
      }
    }
    return Promise.all(promises).then(() => undefined);
  }

  /**
   * Run `fetcher` for `key`, deduping concurrent calls and guarding against
   * stale responses. The fetch is bound to the entry's generation at call
   * time; if `generation` advances (because the entry was invalidated or
   * a newer fetch beat us), the resolved value is dropped silently.
   */
  fetch<T>(key: SyncKey, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.ensure<T>(key);
    if (entry.promise) return entry.promise;
    const generation = ++entry.generation;
    entry.status = "loading";
    entry.error = undefined;
    this.notify(entry);
    const promise = (async () => {
      try {
        const data = await fetcher();
        if (entry.generation !== generation) return data;
        entry.data = data;
        entry.status = "success";
        entry.updatedAtMs = this.now();
        entry.fetchedAtMs = entry.updatedAtMs;
        this.notify(entry);
        return data;
      } catch (cause) {
        if (entry.generation !== generation) throw cause;
        entry.status = "error";
        entry.error = cause instanceof Error ? cause : new Error(String(cause));
        this.notify(entry);
        throw entry.error;
      } finally {
        if (entry.generation === generation) entry.promise = undefined;
      }
    })();
    entry.promise = promise as Promise<unknown> as Promise<T>;
    return promise;
  }

  /** Stash a lastSeq for an entry (used by stream subscribers across reconnect). */
  setLastSeq(key: SyncKey, seq: number): void {
    const entry = this.ensure(key);
    if (entry.lastSeq === undefined || seq > entry.lastSeq) {
      entry.lastSeq = seq;
    }
  }

  /** Forcibly drop `key` from the cache (still notifies). */
  remove(key: SyncKey): void {
    const fingerprint = syncKeyFingerprint(key);
    const entry = this.entries.get(fingerprint);
    if (!entry) return;
    entry.generation += 1;
    entry.promise = undefined;
    entry.version += 1;
    this.entries.delete(fingerprint);
    this.cancelGc(fingerprint);
    const listeners = this.listeners.get(fingerprint);
    if (listeners) {
      for (const listener of listeners) listener(entry);
    }
    for (const listener of this.globals) listener(entry);
  }

  /** Wipe everything. Aborts in-flight tracking by bumping every generation. */
  clear(): void {
    for (const handle of this.gcHandles.values()) this.clearTimer(handle);
    this.gcHandles.clear();
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      entry.promise = undefined;
      entry.version += 1;
    }
    this.entries.clear();
    this.listeners.clear();
  }

  /** True when the entry is older than `staleTimeMs` (or has no data). */
  isStale(key: SyncKey, staleTimeMs: number): boolean {
    const entry = this.entries.get(syncKeyFingerprint(key));
    if (!entry || entry.fetchedAtMs === 0) return true;
    return this.now() - entry.fetchedAtMs >= staleTimeMs;
  }

  /** Observer count for `key`, mainly for tests. */
  observerCount(key: SyncKey): number {
    return this.entries.get(syncKeyFingerprint(key))?.observers ?? 0;
  }

  /** Iterate every entry currently in the cache. */
  snapshot(): Iterable<SyncCacheEntry> {
    return this.entries.values();
  }

  private notify(entry: SyncCacheEntry): void {
    entry.version += 1;
    const listeners = this.listeners.get(entry.fingerprint);
    if (listeners) {
      for (const listener of listeners) listener(entry);
    }
    for (const listener of this.globals) listener(entry);
  }

  private scheduleGc(fingerprint: string): void {
    this.cancelGc(fingerprint);
    const handle = this.setTimer(() => {
      this.gcHandles.delete(fingerprint);
      const entry = this.entries.get(fingerprint);
      if (entry && entry.observers === 0) {
        entry.generation += 1;
        entry.promise = undefined;
        this.entries.delete(fingerprint);
      }
    }, this.cacheTimeMs);
    this.gcHandles.set(fingerprint, handle);
  }

  private cancelGc(fingerprint: string): void {
    const handle = this.gcHandles.get(fingerprint);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.gcHandles.delete(fingerprint);
    }
  }
}
