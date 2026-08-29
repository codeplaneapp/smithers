export type BufferStore = {
  save(entries: string[]): Promise<void>;
};

export async function flushBuffer(entries: string[], store: BufferStore): Promise<number> {
  const batch = [...entries];
  await store.save(batch);
  entries.length = 0;
  return batch.length;
}
