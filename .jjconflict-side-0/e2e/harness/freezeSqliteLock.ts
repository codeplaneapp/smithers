import { Database } from "bun:sqlite";

export interface FreezeSqliteLockHandle {
  release: () => Promise<void>;
}

export async function freezeSqliteLock(
  dbPath: string,
  durationMs?: number,
): Promise<FreezeSqliteLockHandle> {
  // IMMEDIATE acquires a reserved lock — blocks other writers but lets readers through,
  // matching the engine's degraded-but-not-dead behavior under a wedged DB.
  const freezer = new Database(dbPath);
  freezer.exec("BEGIN IMMEDIATE");

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (autoTimer !== undefined) {
      clearTimeout(autoTimer);
    }
    try {
      freezer.exec("COMMIT");
    } finally {
      freezer.close();
    }
  };

  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  if (durationMs !== undefined && durationMs > 0) {
    autoTimer = setTimeout(() => {
      void release();
    }, durationMs);
  }

  return { release };
}
