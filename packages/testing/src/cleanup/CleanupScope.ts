export type CleanupResource = Readonly<{ readonly kind: string; readonly id: string }>;
export class CleanupScope {
  private readonly entries: { resource: CleanupResource; dispose: () => void | Promise<void> }[] = [];
  private readonly live = new Map<string, { resource: CleanupResource; operation: Promise<unknown> }>();
  private closed = false;
  add(resource: CleanupResource, dispose: () => void | Promise<void>): () => void { if (this.closed) throw new Error("CLEANUP_SCOPE_CLOSED"); const entry = { resource, dispose }; this.entries.push(entry); return () => { const i = this.entries.indexOf(entry); if (i >= 0) this.entries.splice(i, 1); }; }
  register(kind: string, id: string, dispose: () => void | Promise<void>): () => void { return this.add({ kind, id }, dispose); }
  pending(): readonly CleanupResource[] { return this.entries.map((e) => e.resource); }
  track(resource: CleanupResource, operation: Promise<unknown>): () => void {
    const key = `${resource.kind}/${resource.id}`;
    this.live.set(key, { resource, operation });
    let released = false;
    const release = () => { if (!released) { released = true; this.live.delete(key); } };
    void operation.then(release, release);
    return release;
  }
  liveResources(): readonly CleanupResource[] { return [...this.live.values()].map((entry) => entry.resource); }
  async close(budget = 100, timeoutMs = 1_000): Promise<void> {
    this.closed = true;
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    let error: unknown;
    const failed: typeof this.entries = [];
    while (this.entries.length) {
      if (++count > budget || Date.now() >= deadline) {
        error ??= Object.assign(new Error("CLEANUP_FAILED: cleanup budget exhausted"), { code: "CLEANUP_FAILED" });
        break;
      }
      // Remove the entry before invoking it. A failed disposer is restored
      // after the pass so it remains visible to leak assertions, while an
      // older resource can still be released in this same bounded cleanup.
      const entry = this.entries.pop()!;
      let disposed = false;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve(entry.dispose()),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error(`cleanup timed out: ${entry.resource.kind}/${entry.resource.id}`), { code: "CLEANUP_TIMEOUT" })), Math.max(0, deadline - Date.now()));
            }),
          ]);
          disposed = true;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch (cause) {
        error ??= Object.assign(new Error(`CLEANUP_FAILED: ${entry.resource.kind}/${entry.resource.id}`), { code: "CLEANUP_FAILED", cause });
      }
      if (!disposed) failed.push(entry);
    }
    this.entries.push(...failed.reverse());
    const pending = [...this.live.values()];
    if (pending.length && Date.now() < deadline) {
      await Promise.race([Promise.allSettled(pending.map((entry) => entry.operation)), new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
    }
    if (error) throw error;
  }
}
