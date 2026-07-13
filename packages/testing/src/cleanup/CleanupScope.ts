export type CleanupResource = Readonly<{ readonly kind: string; readonly id: string }>;
export class CleanupScope {
  private readonly entries: { resource: CleanupResource; dispose: () => void | Promise<void> }[] = [];
  private closed = false;
  add(resource: CleanupResource, dispose: () => void | Promise<void>): () => void { if (this.closed) throw new Error("CLEANUP_SCOPE_CLOSED"); const entry = { resource, dispose }; this.entries.push(entry); return () => { const i = this.entries.indexOf(entry); if (i >= 0) this.entries.splice(i, 1); }; }
  register(kind: string, id: string, dispose: () => void | Promise<void>): () => void { return this.add({ kind, id }, dispose); }
  pending(): readonly CleanupResource[] { return this.entries.map((e) => e.resource); }
  async close(budget = 100, timeoutMs = 1_000): Promise<void> {
    this.closed = true;
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    let error: unknown;
    while (this.entries.length) {
      if (++count > budget || Date.now() >= deadline) {
        error ??= Object.assign(new Error("CLEANUP_FAILED: cleanup budget exhausted"), { code: "CLEANUP_FAILED" });
        break;
      }
      const entry = this.entries[this.entries.length - 1]!;
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
      // A broken disposer must not block older resources from being released.
      // Remove it while preserving the first failure for the caller.
      this.entries.pop();
    }
    if (error) throw error;
  }
}
