/**
 * The Platform DI surface. ui-core code reads capabilities through these
 * interfaces instead of touching a host directly (no `window`, `document`,
 * `localStorage`, ...); each shell (multi's web app, packages/tui's terminal
 * app) supplies one concrete `Platform` at boot via `setPlatform`. Every port
 * fails soft: an unavailable capability returns a typed "unavailable" result,
 * it never throws at the call site.
 */

export type PortResult<T = void> = { ok: true; value: T } | { ok: false; reason: string };

/** localStorage analog, namespaced by the caller. Synchronous, like the web API it replaces. */
export type KeyValueStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

/** Copy text to the system clipboard. TUI: OSC 52, falling back to pbcopy/xclip. */
export type ClipboardPort = {
  copy(text: string): Promise<PortResult>;
};

/** Open a URL/file outside the app, or save bytes to disk. TUI: `open`/`xdg-open`, or print the path. */
export type OpenExternalPort = {
  openUrl(url: string): Promise<PortResult>;
  saveFile(name: string, bytes: Uint8Array): Promise<PortResult<{ path: string }>>;
};

export type NotifyLevel = "info" | "success" | "warning" | "error";

/** In-app toasts. TUI: a status-line flash. OS-level notifications are out of scope for v1. */
export type NotifyPort = {
  notify(message: string, level?: NotifyLevel): void;
};

/**
 * A single navigable location. Deep-link round-trippable as a URL string so a
 * TUI state is shareable with the web app (see deriveRoute in multi).
 */
export type RouteState = {
  surface: string;
  params?: Record<string, string>;
};

/** Open/back/forward over app navigation. TUI: routeStore + a bounded history stack. */
export type NavigationPort = {
  openSurface(route: RouteState): void;
  back(): void;
  forward(): void;
  current(): RouteState;
};

/** App focus + visibility signals (ResizeObserver/matchMedia analog on web; process-local on TUI). */
export type FocusVisibilityPort = {
  isFocused(): boolean;
  isVisible(): boolean;
  subscribe(callback: (state: { focused: boolean; visible: boolean }) => void): () => void;
};

export type ViewportSize = { cols: number; rows: number } | { width: number; height: number };

/** Terminal cols/rows or browser px, plus the compact-layout breakpoint. */
export type ViewportPort = {
  size(): ViewportSize;
  compact(): boolean;
  subscribe(callback: (size: ViewportSize) => void): () => void;
};

export type AuthPrincipal = {
  id: string;
  name?: string;
};

/** The current principal + change events. TUI: derived from the gateway token, a no-op change stream. */
export type AuthPort = {
  principal(): AuthPrincipal | null;
  subscribe(callback: (principal: AuthPrincipal | null) => void): () => void;
};

/** The chat timeline store (IndexedDB on web). TUI: bun:sqlite or a JSON log in the workspace state dir. */
export type TimelinePersistencePort = {
  load(timelineId: string): Promise<unknown | null>;
  save(timelineId: string, record: unknown): Promise<void>;
  remove(timelineId: string): Promise<void>;
};

/** Speech-to-text. Absent in TUI v1; optional so callers fail soft without it. */
export type SpeechPort = {
  isSupported(): boolean;
  start(onResult: (text: string) => void): () => void;
};

export type Platform = {
  storage: KeyValueStorage;
  clipboard: ClipboardPort;
  openExternal: OpenExternalPort;
  notify: NotifyPort;
  navigation: NavigationPort;
  focus: FocusVisibilityPort;
  viewport: ViewportPort;
  auth: AuthPort;
  persistence: TimelinePersistencePort;
  speech?: SpeechPort;
};
