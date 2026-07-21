/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { Input } from "../input";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { Skeleton } from "../skeleton";
import { useInjectUiCss } from "../styles";
import { SANDBOX_CSS_ID, sandboxCss } from "./sandboxCss";

export type WebPreviewSandboxToken =
  | "allow-scripts"
  | "allow-forms"
  | "allow-popups"
  | "allow-downloads"
  | "allow-same-origin";

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The hard rule: allow-same-origin + allow-scripts never render together. */
function resolveSandboxTokens(tokens: readonly WebPreviewSandboxToken[]): readonly WebPreviewSandboxToken[] {
  if (tokens.includes("allow-same-origin") && tokens.includes("allow-scripts")) {
    console.warn(
      "WebPreviewContent: dropping the allow-same-origin sandbox token because it is combined with allow-scripts; the pair would let the framed page remove its own sandbox.",
    );
    return tokens.filter((token) => token !== "allow-same-origin");
  }
  return tokens;
}

type WebPreviewContextValue = {
  url: string | undefined;
  commitUrl: (url: string) => boolean;
  loading: boolean;
};

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]";

function useRovingTabIndex(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    items.forEach((el, index) => {
      el.tabIndex = index === 0 ? 0 : -1;
    });
  });

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowRight" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items.forEach((el, index) => {
      el.tabIndex = index === next ? 0 : -1;
    });
    items[next]!.focus();
  }

  return onKeyDown;
}

export type WebPreviewProps = Omit<ComponentProps<"div">, "children"> & {
  url?: string;
  defaultUrl?: string;
  onUrlChange?: (url: string) => void;
  loading?: boolean;
  children?: ReactNode;
};

/**
 * Sandboxed web preview frame with an honest navigation model: back/forward/
 * refresh are host callbacks, the address bar only commits http(s) URLs, and
 * the iframe sandbox attribute is always rendered from an explicit token list.
 */
export function WebPreview({
  url: controlledUrl,
  defaultUrl,
  onUrlChange,
  loading = false,
  className,
  children,
  ...props
}: WebPreviewProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const [uncontrolledUrl, setUncontrolledUrl] = useState(defaultUrl);
  const isControlled = controlledUrl !== undefined;
  const url = isControlled ? controlledUrl : uncontrolledUrl;

  function commitUrl(next: string): boolean {
    if (!isHttpUrl(next)) return false;
    if (!isControlled) setUncontrolledUrl(next);
    onUrlChange?.(next);
    return true;
  }

  return (
    <div
      data-slot="web-preview"
      data-loading={loading ? "true" : "false"}
      className={cn("sui-webpreview", className)}
      {...props}
    >
      <WebPreviewContext.Provider value={{ url, commitUrl, loading }}>
        {children ?? (
          <>
            <WebPreviewToolbar>
              <WebPreviewAddress />
            </WebPreviewToolbar>
            <WebPreviewContent />
          </>
        )}
      </WebPreviewContext.Provider>
    </div>
  );
}

export type WebPreviewToolbarProps = Omit<ComponentProps<"div">, "children"> & {
  onBack?: () => void;
  onForward?: () => void;
  onRefresh?: () => void;
  children?: ReactNode;
};

export function WebPreviewToolbar({
  onBack,
  onForward,
  onRefresh,
  className,
  children,
  onKeyDown,
  ...props
}: WebPreviewToolbarProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ref = useRef<HTMLDivElement | null>(null);
  const rovingKeyDown = useRovingTabIndex(ref);
  return (
    <div
      ref={ref}
      data-slot="web-preview-toolbar"
      role="toolbar"
      aria-label="Preview controls"
      className={cn("sui-webpreview-toolbar", className)}
      onKeyDown={(event) => {
        rovingKeyDown(event);
        onKeyDown?.(event);
      }}
      {...props}
    >
      {onBack ? (
        <button
          type="button"
          data-slot="web-preview-back"
          className="sui-webpreview-toolbar-button"
          aria-label="Back"
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
        </button>
      ) : null}
      {onForward ? (
        <button
          type="button"
          data-slot="web-preview-forward"
          className="sui-webpreview-toolbar-button"
          aria-label="Forward"
          onClick={onForward}
        >
          <span aria-hidden="true">→</span>
        </button>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          data-slot="web-preview-refresh"
          className="sui-webpreview-toolbar-button"
          aria-label="Refresh"
          onClick={onRefresh}
        >
          <span aria-hidden="true">⟳</span>
        </button>
      ) : null}
      {children}
    </div>
  );
}

export type WebPreviewAddressProps = Omit<ComponentProps<"input">, "value" | "onChange" | "type">;

export function WebPreviewAddress({
  className,
  onKeyDown,
  "aria-label": ariaLabel = "Preview address",
  ...props
}: WebPreviewAddressProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ctx = useContext(WebPreviewContext);
  const errorId = useId();
  const [draft, setDraft] = useState(ctx?.url ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(ctx?.url ?? "");
  }, [ctx?.url]);

  function commit() {
    if (ctx !== null) {
      setError(ctx.commitUrl(draft) ? null : "Enter a valid http:// or https:// URL.");
    } else {
      setError(isHttpUrl(draft) ? null : "Enter a valid http:// or https:// URL.");
    }
  }

  return (
    <span data-slot="web-preview-address" className="sui-webpreview-address-row">
      <Input
        type="url"
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        className={cn("sui-webpreview-address", className)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          onKeyDown?.(event);
        }}
        {...props}
      />
      {error !== null ? (
        <span id={errorId} role="alert" data-slot="web-preview-address-error" className="sui-webpreview-address-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export type WebPreviewContentProps = Omit<ComponentProps<"iframe">, "src" | "sandbox"> & {
  src?: string;
  sandboxAllow?: readonly WebPreviewSandboxToken[];
};

export function WebPreviewContent({
  src,
  sandboxAllow = ["allow-scripts", "allow-forms"],
  title = "Web preview",
  className,
  ...props
}: WebPreviewContentProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ctx = useContext(WebPreviewContext);
  const effectiveSrc = src ?? ctx?.url;
  const loading = ctx?.loading ?? false;
  if (effectiveSrc === undefined || effectiveSrc === "") {
    return (
      <div data-slot="web-preview-content" className={cn("sui-webpreview-content", className)}>
        <EmptyState title="No preview available" />
      </div>
    );
  }
  const sandboxTokens = resolveSandboxTokens(sandboxAllow);
  return (
    <div data-slot="web-preview-content" data-loading={loading ? "true" : "false"} className="sui-webpreview-content">
      {loading ? <Skeleton data-slot="web-preview-loading" className="sui-webpreview-loading" /> : null}
      <iframe
        title={title}
        src={effectiveSrc}
        sandbox={sandboxTokens.join(" ")}
        className={cn("sui-webpreview-frame", className)}
        {...props}
      />
    </div>
  );
}
