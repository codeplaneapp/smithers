import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  autosaveStatusText,
  createAutosaveDoc,
  type AutosaveDoc,
  type AutosaveDocOptions,
  type AutosaveState,
} from "./autosaveMachine";

export type UseAutosaveDocOptions = AutosaveDocOptions;

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
 * React binding for the autosave state machine. The machine is created once
 * (callbacks proxied through refs so the latest closures are used without
 * recreating the document) and torn down on unmount.
 */
export function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult {
  const saveRef = useRef(options.save);
  const readExternalRef = useRef(options.readExternal);
  useEffect(() => {
    saveRef.current = options.save;
    readExternalRef.current = options.readExternal;
  });

  const docRef = useRef<AutosaveDoc | null>(null);
  if (docRef.current === null) {
    docRef.current = createAutosaveDoc({
      initialValue: options.initialValue,
      initialMtimeMs: options.initialMtimeMs,
      debounceMs: options.debounceMs,
      schedule: options.schedule,
      save: (value) => saveRef.current(value),
      readExternal: options.readExternal ? () => readExternalRef.current!() : undefined,
    });
  }
  useEffect(
    () => () => {
      docRef.current?.dispose();
      docRef.current = null;
    },
    [],
  );

  const subscribe = useCallback((listener: () => void) => docRef.current!.subscribe(listener), []);
  const getSnapshot = useCallback(() => docRef.current!.getSnapshot(), []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback((value: string) => docRef.current!.setValue(value), []);
  const saveNow = useCallback(() => docRef.current!.saveNow(), []);
  const discardExternal = useCallback(() => docRef.current!.discardExternal(), []);

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
