import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  autosaveStatusText,
  createAutosaveDoc,
  type AutosaveDoc,
  type AutosaveDocOptions,
  type AutosaveState,
} from "./autosaveMachine";

export type UseAutosaveDocOptions = AutosaveDocOptions & {
  /** Change this identity when switching documents so local state is re-seeded. */
  resetKey?: string | number;
};

export type UseAutosaveDocResult = {
  value: string;
  setValue: (value: string) => void;
  state: AutosaveState;
  /** Reduced-motion-safe status line (plain text, "" while clean). */
  statusText: string;
  mtimeMs: number | undefined;
  saveNow: () => Promise<void>;
  discardExternal: () => Promise<void>;
};

/**
 * React binding for the autosave state machine. The machine is recreated when
 * `resetKey` changes; callbacks are otherwise proxied through refs so the
 * latest closures are used without resetting the active document.
 *
 * Both lifecycle exits flush first: switching documents and unmounting each
 * write a dirty draft before disposing its machine, so no exit silently drops
 * an unsaved edit.
 */
/**
 * One machine plus the callbacks it was rendered with. The callbacks live on
 * the entry rather than on a hook-wide ref so a machine retired by a `resetKey`
 * change keeps writing through ITS document's `save`. A shared ref would flush
 * document A's outgoing draft through document B's writer.
 */
type DocEntry = {
  readonly doc: AutosaveDoc;
  save: AutosaveDocOptions["save"];
  readExternal: AutosaveDocOptions["readExternal"];
};

export function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const entryRef = useRef<DocEntry | null>(null);
  const resetKeyRef = useRef(options.resetKey);
  // Machines the reset below retired but that have not been flushed yet.
  // Retiring during render must NOT dispose: `dispose()` cancels the pending
  // debounce, so disposing here would silently drop the outgoing document's
  // unsaved draft -- the opposite of what the unmount path below does. React
  // may also discard a render outright, and a discarded render must not have
  // destroyed live state. The effect after the commit owns the teardown.
  const retiredRef = useRef<Array<DocEntry>>([]);
  if (!Object.is(resetKeyRef.current, options.resetKey)) {
    if (entryRef.current) retiredRef.current.push(entryRef.current);
    entryRef.current = null;
    resetKeyRef.current = options.resetKey;
  }
  // The live machine's proxies must observe callbacks from THIS render.
  // Updating in an effect leaves a commit where saveNow still calls
  // stale/absent callbacks.
  if (entryRef.current) {
    entryRef.current.save = options.save;
    entryRef.current.readExternal = options.readExternal;
  }

  const getEntry = useCallback((): DocEntry => {
    const existing = entryRef.current;
    if (existing) return existing;
    const current = optionsRef.current;
    const entry: DocEntry = {
      save: current.save,
      readExternal: current.readExternal,
      doc: createAutosaveDoc({
        initialValue: current.initialValue,
        initialMtimeMs: current.initialMtimeMs,
        debounceMs: current.debounceMs,
        schedule: current.schedule,
        save: (value) => entry.save(value),
        // Always install the proxy so a callback supplied after mount is picked
        // up. `undefined` distinguishes "not configured" from a configured
        // reader that failed, which the state machine must treat as a conflict.
        readExternal: async () => {
          const readExternal = entry.readExternal;
          if (!readExternal) return undefined;
          return readExternal();
        },
      }),
    };
    entryRef.current = entry;
    return entry;
  }, [options.resetKey]);

  const getDoc = useCallback((): AutosaveDoc => getEntry().doc, [getEntry]);

  getDoc();

  // Flush-then-dispose every machine the reset retired, after the commit that
  // retired it. Same policy as the unmount path: a dirty document is written
  // before its machine goes away, so switching documents never loses a draft.
  useEffect(() => {
    const retired = retiredRef.current.splice(0);
    for (const entry of retired) {
      const flush = entry.doc.getSnapshot().state === "dirty" ? entry.doc.saveNow() : Promise.resolve();
      const dispose = () => entry.doc.dispose();
      void flush.then(dispose, dispose);
    }
  });

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode immediately re-runs effect setup without re-rendering.
      // Deferring disposal by one microtask lets that setup retain the same
      // live machine and its pending save; a real unmount still disposes it.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        const entry = entryRef.current;
        if (!entry) return;
        const doc = entry.doc;
        const flush = doc.getSnapshot().state === "dirty" ? doc.saveNow() : Promise.resolve();
        const dispose = () => {
          if (mountedRef.current || entryRef.current !== entry) return;
          doc.dispose();
          entryRef.current = null;
        };
        void flush.then(dispose, dispose);
      });
    };
  }, []);

  const subscribe = useCallback((listener: () => void) => getDoc().subscribe(listener), [getDoc]);
  const getSnapshot = useCallback(() => getDoc().getSnapshot(), [getDoc]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback((value: string) => getDoc().setValue(value), [getDoc]);
  const saveNow = useCallback(() => getDoc().saveNow(), [getDoc]);
  const discardExternal = useCallback(() => getDoc().discardExternal(), [getDoc]);

  return {
    value: snapshot.value,
    setValue,
    state: snapshot.state,
    statusText: autosaveStatusText(snapshot.state),
    mtimeMs: snapshot.mtimeMs,
    saveNow,
    discardExternal,
  };
}
