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
 */
export function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult {
  const saveRef = useRef(options.save);
  const readExternalRef = useRef(options.readExternal);
  const optionsRef = useRef(options);
  // These proxies must observe callbacks from this render. Updating in an
  // effect leaves a commit where saveNow still calls stale/absent callbacks.
  saveRef.current = options.save;
  readExternalRef.current = options.readExternal;
  optionsRef.current = options;

  const docRef = useRef<AutosaveDoc | null>(null);
  const resetKeyRef = useRef(options.resetKey);
  if (!Object.is(resetKeyRef.current, options.resetKey)) {
    docRef.current?.dispose();
    docRef.current = null;
    resetKeyRef.current = options.resetKey;
  }
  const getDoc = useCallback((): AutosaveDoc => {
    if (docRef.current) return docRef.current;
    const current = optionsRef.current;
    docRef.current = createAutosaveDoc({
      initialValue: current.initialValue,
      initialMtimeMs: current.initialMtimeMs,
      debounceMs: current.debounceMs,
      schedule: current.schedule,
      save: (value) => saveRef.current(value),
      // Always install the proxy so a callback supplied after mount is picked
      // up. `undefined` distinguishes "not configured" from a configured
      // reader that failed, which the state machine must treat as a conflict.
      readExternal: async () => {
        const readExternal = readExternalRef.current;
        if (!readExternal) return undefined;
        return readExternal();
      },
    });
    return docRef.current;
  }, [options.resetKey]);

  getDoc();

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
        const doc = docRef.current;
        if (!doc) return;
        const flush = doc.getSnapshot().state === "dirty" ? doc.saveNow() : Promise.resolve();
        const dispose = () => {
          if (mountedRef.current || docRef.current !== doc) return;
          doc.dispose();
          docRef.current = null;
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
