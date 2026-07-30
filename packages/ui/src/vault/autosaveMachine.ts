/**
 * The autosave state machine behind {@link useAutosaveDoc}, ported from the
 * VaultPane save logic (Unsaved / Saving / Saved / Changed-on-disk). Pure and
 * DOM-free: timers are injectable so tests drive them manually.
 */

export type AutosaveState = "clean" | "dirty" | "saving" | "saved" | "conflict";

export type AutosaveSnapshot = {
  readonly value: string;
  readonly state: AutosaveState;
  readonly mtimeMs: number | undefined;
};

export type AutosaveDocOptions = {
  /** Document text at load time. */
  initialValue: string;
  /** File mtime at load time; the conflict-check baseline. */
  initialMtimeMs?: number;
  /** Persist the current text; resolves with the new mtime when known. */
  save: (value: string) => Promise<{ mtimeMs?: number } | void>;
  /**
   * Read the on-disk copy for conflict detection. When the file's mtime has
   * moved past our baseline AND its content differs from ours, the save is
   * refused and the machine lands in `conflict` instead of blindly
   * overwriting someone else's edit.
   */
  readExternal?: () => Promise<{ content: string; mtimeMs?: number }>;
  /** Debounce window for edit-triggered saves (default 800ms). */
  debounceMs?: number;
  /** Injectable scheduler (returns a cancel fn); defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

export type AutosaveDoc = {
  /** Cached snapshot; identity changes only when emitted state changes. */
  getSnapshot(): AutosaveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Record an edit: marks dirty and schedules a debounced save. */
  setValue(value: string): void;
  /** Save immediately, skipping the debounce. */
  saveNow(): Promise<void>;
  /**
   * Resolve a conflict by discarding the external (on-disk) version:
   * re-baselines the mtime to the current file and saves the local text.
   */
  discardExternal(): Promise<void>;
  dispose(): void;
};

/**
 * Status line copy per state. Plain text only — no animated ellipsis or
 * spinner — so it is stable under prefers-reduced-motion. `clean` renders
 * nothing (the VaultPane "idle" convention: no pill until the first edit).
 */
export const AUTOSAVE_STATUS_TEXT: Record<AutosaveState, string> = {
  clean: "",
  dirty: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  conflict: "Changed on disk",
};

export function autosaveStatusText(state: AutosaveState): string {
  return AUTOSAVE_STATUS_TEXT[state];
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createAutosaveDoc(options: AutosaveDocOptions): AutosaveDoc {
  const debounceMs = options.debounceMs ?? 800;
  const schedule = options.schedule ?? defaultSchedule;

  let value = options.initialValue;
  let state: AutosaveState = "clean";
  let mtimeMs = options.initialMtimeMs;
  let cancelPending: (() => void) | null = null;
  let inflight = false;
  let inflightDone: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  let snapshot: AutosaveSnapshot = { value, state, mtimeMs };

  function emit(nextState?: AutosaveState): void {
    if (nextState !== undefined) state = nextState;
    snapshot = { value, state, mtimeMs };
    for (const listener of listeners) listener();
  }

  function cancelScheduled(): void {
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
  }

  function scheduleFlush(): void {
    cancelScheduled();
    cancelPending = schedule(() => {
      cancelPending = null;
      void saveNow();
    }, debounceMs);
  }

  /** True when the on-disk copy moved under us with different content. */
  async function detectConflict(): Promise<boolean> {
    if (!options.readExternal) return false;
    let external: { content: string; mtimeMs?: number };
    try {
      external = await options.readExternal();
    } catch {
      // A failed check must never block a save.
      return false;
    }
    if (external.mtimeMs === undefined || mtimeMs === undefined) return false;
    return external.mtimeMs > mtimeMs && external.content !== value;
  }

  async function saveNow(): Promise<void> {
    cancelScheduled();
    if (disposed || inflight) return;
    // Conflict detection is asynchronous too, so acquire the single-flight
    // guard before it. Same-tick callers can no longer overlap writes.
    inflight = true;
    let finishInflight!: () => void;
    inflightDone = new Promise<void>((resolve) => {
      finishInflight = resolve;
    });
    try {
      if (await detectConflict()) {
        if (!disposed) emit("conflict");
        return;
      }
      if (disposed) return;
      const savingValue = value;
      emit("saving");
      const result = await options.save(savingValue);
      if (disposed) return;
      mtimeMs = result?.mtimeMs ?? mtimeMs;
      // Edits during the flight are not covered by this save: stay dirty.
      emit(value === savingValue ? "saved" : "dirty");
    } catch {
      // Still unsaved; the next edit (or saveNow retry) will attempt again.
      if (!disposed) emit("dirty");
    } finally {
      inflight = false;
      finishInflight();
      inflightDone = null;
    }
    if (!disposed && state === "dirty") scheduleFlush();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setValue(next: string) {
      if (disposed) return;
      // Echoes of the current text (serializer normalization on hydrate)
      // must not dirty a clean document: viewing stays read-only.
      if (next === value && (state === "clean" || state === "saved")) return;
      value = next;
      scheduleFlush();
      emit("dirty");
    },
    saveNow,
    async discardExternal() {
      if (disposed) return;
      if (inflightDone) await inflightDone;
      if (options.readExternal) {
        try {
          const external = await options.readExternal();
          mtimeMs = external.mtimeMs ?? mtimeMs;
        } catch {
          // Re-baseline is best effort; saveNow proceeds regardless.
        }
      }
      emit("dirty");
      await saveNow();
    },
    dispose() {
      disposed = true;
      cancelScheduled();
      listeners.clear();
    },
  };
}
