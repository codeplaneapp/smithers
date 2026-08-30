/** @jsxImportSource react */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useInsertionEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { crepeThemeCss } from "./crepeTheme.generated";

/**
 * The shared WYSIWYG markdown editor for every Smithers UI, ported from Multi's
 * `files/MarkdownEditor.tsx`. It is a Milkdown Crepe (ProseMirror) editor: the
 * user edits rendered markdown directly, never raw source. This is the single
 * replacement for the three former ad-hoc editors (the docs-driven-development
 * textarea editor, the create-workflow `cw-editor`, and Multi's file editor).
 *
 * It is deliberately generic — props-driven with zero coupling to any app
 * store, router, or draft-reconciliation logic. Two data directions:
 *  - LOCAL edits stream out through `onChange`.
 *  - EXTERNAL updates (multiplayer, resets, programmatic seeds) apply through
 *    the imperative {@link MarkdownEditorHandle.setMarkdown}, which rebuilds the
 *    document via Milkdown's `replaceAll` macro and suppresses the resulting
 *    `markdownUpdated` echo so it never loops back out as a local edit.
 *
 * Because the Crepe editor is a heavy `@milkdown/*` dependency it lives in the
 * `adapters/` layer and is imported through the explicit
 * `@smthrs/ui/adapters/markdown-editor` subpath (never the base
 * `index` barrel). Its ProseMirror runtime never paints under `renderToString`,
 * happy-dom, or bun's test DOM, so in those environments the component degrades
 * to a plain, fully controlled `<textarea>` that honours the exact same
 * `value` / `onChange` / `readOnly` / `resetKey` contract and imperative
 * handle. This is the same fallback strategy the docs-driven-development editor
 * uses, and it keeps the whole surface testable off the real editor.
 */
export type MarkdownEditorHandle = {
  /** The current serialized markdown document. */
  getMarkdown: () => string;
  /**
   * Replace the whole document from an external update. Echo-suppressed: the
   * resulting change does NOT fire `onChange`, so callers can seed multiplayer
   * or reset content without it looping back as a local edit.
   */
  setMarkdown: (markdown: string) => void;
};

export type MarkdownEditorProps = {
  /**
   * The INITIAL markdown document. After mount, live edits flow through
   * `onChange` (and reseed via `resetKey`/`setMarkdown`), NOT by re-seeding on
   * every `value` change — that would yank the caret mid-typing.
   */
  value: string;
  /** Fires with the serialized markdown on every local edit. */
  onChange?: (markdown: string) => void;
  /** When true the document is not editable. */
  readOnly?: boolean;
  /**
   * Change this to force the editor to re-seed from `value` and re-initialize
   * (the generic analogue of Multi's per-document `docPath` remount key).
   */
  resetKey?: string | number;
  /** Extra class names on the editor host / fallback textarea. */
  className?: string;
  /** Accessible label, forwarded to the host and fallback textarea. */
  "aria-label"?: string;
  /**
   * Whether Tab and Shift+Tab move focus out of the editor rather than
   * inserting indentation. Defaults to true.
   *
   * ProseMirror binds Tab to "insert indentation", which makes the editor a
   * focus trap: a keyboard user who reaches it can never leave (an accessibility
   * bar, and LIBRARY-CHANGE-REQUESTS §4). Indentation stays available on the
   * editor's own list and block commands, which is what every editor that
   * ships inside a form does. Set this to false to restore ProseMirror's
   * binding for a surface where the editor is the whole page.
   */
  escapeTabOrder?: boolean;
};

/** Marker attribute on the injected Crepe theme `<style>` (deduped on it). */
export const MARKDOWN_EDITOR_STYLE_ATTR = "data-smithers-markdown-editor";

/** Host chrome for the Crepe editor plus the fallback textarea, namespaced. */
const hostCss = `
.sui-markdown-editor { min-width:0; min-height:0; height:100%; overflow:auto; }
.sui-markdown-editor .milkdown { height:100%; }
.sui-markdown-editor .milkdown .ProseMirror { padding:16px 20px; }
.sui-markdown-editor-fallback { display:block; box-sizing:border-box; width:100%; min-height:180px; height:100%; padding:16px 20px; border:0; outline:none; resize:none; background:transparent; color:inherit; font:inherit; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:13px; line-height:1.6; tab-size:2; }
.sui-markdown-editor-fallback:read-only { cursor:default; }
`.trim();

/**
 * KaTeX's bundled font declarations point at files this source-shipping
 * package does not include. Strip those declarations from the emitted sheet
 * so math uses the existing fallback stack without making network requests.
 */
const selfContainedCrepeThemeCss = crepeThemeCss.replace(/@font-face\s*\{[^}]*\}/g, "");

/** The complete self-contained stylesheet the adapter injects: Crepe theme + host chrome. */
export const markdownEditorCss = `${selfContainedCrepeThemeCss}\n${hostCss}`;

/**
 * Browser fallback injector (mirrors `useInjectUiCss` in the base package):
 * idempotently appends the Crepe theme + host chrome to `<head>` so a consumer
 * who never renders {@link MarkdownEditorStyles} still gets a styled editor.
 * No-ops during server rendering.
 */
export function useInjectMarkdownEditorCss(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(MARKDOWN_EDITOR_STYLE_ATTR, "");
    el.textContent = markdownEditorCss;
    document.head.appendChild(el);
  }, []);
}

/** Render the Crepe theme sheet in a `<style>` tag (SSR-safe escape hatch). */
export function MarkdownEditorStyles() {
  // Literal attribute name (JSX cannot use the MARKDOWN_EDITOR_STYLE_ATTR
  // constant here); keep the two in sync — useInjectMarkdownEditorCss dedupes
  // on the same attribute.
  return <style data-smithers-markdown-editor="">{markdownEditorCss}</style>;
}

/**
 * True when the ProseMirror editor cannot paint (server render, happy-dom, or
 * bun's test DOM). In those environments the component renders the controlled
 * `<textarea>` fallback so the value/onChange/readOnly/resetKey contract stays
 * exercised without the real editor.
 */
function prefersTextareaFallback(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return true;
  if (typeof document.createElement !== "function") return true;
  const agent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /happy-?dom|jsdom|\bBun\//i.test(agent);
}

type CrepeListener = {
  markdownUpdated: (handler: (_ctx: unknown, markdown: string) => void) => void;
};

type CrepeInstance = {
  editor: { action: (command: unknown) => unknown };
  on: (configure: (listener: CrepeListener) => void) => unknown;
  create: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  setReadonly: (readOnly: boolean) => unknown;
};

/**
 * Hands Tab back to the browser.
 *
 * The handler runs in the capture phase, above ProseMirror's own keymap, so
 * the editor never sees the key and the document's focus order is the one the
 * page declares. `Escape`-style chords and every other key are untouched.
 *
 * @param event the keyboard event
 */
const releaseTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
};

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, readOnly = false, resetKey, className, "aria-label": ariaLabel, escapeTabOrder = true },
  ref,
) {
  useInjectMarkdownEditorCss();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<CrepeInstance | null>(null);
  const readyRef = useRef(false);
  const replaceAllRef = useRef<typeof import("@milkdown/kit/utils").replaceAll | null>(null);
  const suppressEchoRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The single source of truth for `getMarkdown`; seeded from `value` and
  // updated by every local edit, external `setMarkdown`, and reseed.
  const lastMarkdownRef = useRef(value);

  const useFallback = prefersTextareaFallback();
  const [fallbackValue, setFallbackValue] = useState(value);

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => lastMarkdownRef.current,
      setMarkdown: (markdown: string) => {
        if (markdown === lastMarkdownRef.current) return;
        lastMarkdownRef.current = markdown;
        setFallbackValue(markdown);
        const crepe = crepeRef.current;
        const replaceAll = replaceAllRef.current;
        if (!crepe || !readyRef.current || !replaceAll) return;
        suppressEchoRef.current += 1;
        try {
          crepe.editor.action(replaceAll(markdown, true));
        } finally {
          // Release on the next tick — replaceAll's markdownUpdated fires
          // synchronously within the action, but be tolerant of async flushes.
          setTimeout(() => {
            suppressEchoRef.current = Math.max(0, suppressEchoRef.current - 1);
          }, 0);
        }
      },
    }),
    [],
  );

  // Reseed the document whenever `resetKey` changes (declared BEFORE the
  // editor effect so the fresh markdown is visible when Crepe re-initializes).
  useEffect(() => {
    lastMarkdownRef.current = value;
    setFallbackValue(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (useFallback) return;
    const host = hostRef.current;
    if (!host) return;
    readyRef.current = false;
    const seed = lastMarkdownRef.current;
    let cancelled = false;
    let crepe: CrepeInstance | null = null;
    host.innerHTML = "";

    void Promise.all([import("@milkdown/crepe"), import("@milkdown/kit/utils")])
      .then(async ([{ Crepe }, { replaceAll }]) => {
        if (cancelled) return;
        replaceAllRef.current = replaceAll;
        const editor = new Crepe({ root: host, defaultValue: seed }) as CrepeInstance;
        crepe = editor;
        crepeRef.current = editor;
        editor.on((listener: CrepeListener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            lastMarkdownRef.current = markdown;
            if (suppressEchoRef.current > 0) return; // programmatic replaceAll echo
            onChangeRef.current?.(markdown);
          });
        });
        await editor.create();
        if (cancelled) {
          void editor.destroy();
          return;
        }
        editor.setReadonly(readOnly);
        readyRef.current = true;
      })
      .catch(() => {
        // WYSIWYG could not initialize; getMarkdown still returns the seed and
        // callers can fall back to their own controls.
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      crepeRef.current = null;
      replaceAllRef.current = null;
      try {
        void crepe?.destroy();
      } catch {
        // A failed teardown must not crash the unmount.
      }
    };
    // Re-init only when the doc reseeds or editability changes; content
    // updates flow through the listener + setMarkdown, never by recreating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, readOnly, useFallback]);

  const onFallbackInput = (next: string) => {
    if (next === lastMarkdownRef.current) return;
    lastMarkdownRef.current = next;
    setFallbackValue(next);
    onChangeRef.current?.(next);
  };

  if (useFallback) {
    return (
      <textarea
        className={className ? `sui-markdown-editor-fallback ${className}` : "sui-markdown-editor-fallback"}
        data-slot="markdown-editor"
        data-testid="markdown-editor"
        data-mode="fallback"
        // A textarea never bound Tab, so the fallback already has the
        // document's focus order; the attribute reports the same setting
        // either way so a host can assert one thing.
        data-escape-tab-order={escapeTabOrder ? "true" : "false"}
        aria-label={ariaLabel}
        readOnly={readOnly}
        value={fallbackValue}
        onChange={(event) => onFallbackInput(event.currentTarget.value)}
      />
    );
  }

  return (
    <div
      className={className ? `sui-markdown-editor ${className}` : "sui-markdown-editor"}
      data-slot="markdown-editor"
      data-testid="markdown-editor"
      data-mode="wysiwyg"
      data-escape-tab-order={escapeTabOrder ? "true" : "false"}
      aria-label={ariaLabel}
      ref={hostRef}
      onKeyDownCapture={escapeTabOrder ? releaseTab : undefined}
    />
  );
});
