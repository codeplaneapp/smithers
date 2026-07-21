/** @jsxImportSource react */
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn";
import { REASONING_TOOLS_CSS_ID, reasoningToolsCss } from "../agentic/reasoningToolsCss";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { useInjectUiCss } from "../styles";

export type HighlightedToken = { text: string; color?: string };
export type HighlightLine = readonly HighlightedToken[];
export type CodeBlockHighlighter = (
  code: string,
  language: string | undefined,
) => readonly HighlightLine[] | null;

export type CodeBlockProps = Omit<ComponentProps<"div">, "onCopy" | "children"> & {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  wrap?: boolean;
  defaultWrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  showCopy?: boolean;
  onCopyCode?: (code: string) => void;
  copiedDurationMs?: number;
  highlight?: CodeBlockHighlighter;
};

/** Dependency-free fenced code with copy, wrapping, line numbers, and a highlighter seam. */
export function CodeBlock({
  code,
  language,
  showLineNumbers = false,
  wrap: controlledWrap,
  defaultWrap = false,
  onWrapChange,
  showCopy = true,
  onCopyCode,
  copiedDurationMs = 2_000,
  highlight,
  className,
  ...props
}: CodeBlockProps) {
  useInjectUiCss();
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  const [uncontrolledWrap, setUncontrolledWrap] = useState(defaultWrap);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isWrapControlled = controlledWrap !== undefined;
  const wrap = isWrapControlled ? controlledWrap : uncontrolledWrap;
  const hasClipboard =
    typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const canCopy = showCopy && (onCopyCode !== undefined || hasClipboard);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  let highlighted: readonly HighlightLine[] | null = null;
  if (highlight) {
    try {
      highlighted = highlight(code, language) ?? null;
    } catch {
      highlighted = null;
    }
  }
  const lines: readonly HighlightLine[] =
    highlighted ?? code.split("\n").map((line) => [{ text: line }]);

  function toggleWrap() {
    const next = !wrap;
    if (!isWrapControlled) setUncontrolledWrap(next);
    onWrapChange?.(next);
  }

  function copyCode() {
    if (onCopyCode) onCopyCode(code);
    else if (hasClipboard) void navigator.clipboard.writeText(code);

    setCopied(true);
    if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined;
      setCopied(false);
    }, copiedDurationMs);
  }

  return (
    <div
      data-slot="code-block"
      data-wrap={wrap ? "true" : "false"}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-codeblock", className)}
      {...props}
    >
      <div data-slot="code-block-header" className="sui-codeblock-header">
        {language !== undefined ? <span className="sui-codeblock-lang">{language}</span> : null}
        <span className="sui-codeblock-actions">
          <button
            type="button"
            data-slot="code-block-wrap"
            className="sui-codeblock-action"
            aria-pressed={wrap}
            aria-label="Toggle line wrap"
            onClick={toggleWrap}
          >
            {wrap ? "Unwrap" : "Wrap"}
          </button>
          {canCopy ? (
            <button
              type="button"
              data-slot="code-block-copy"
              className="sui-codeblock-action"
              aria-label="Copy code"
              onClick={copyCode}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </span>
      </div>
      <pre
        data-slot="code-block-body"
        className="sui-codeblock-body"
        role="region"
        aria-label={language ? `${language} code` : "Code"}
        tabIndex={0}
      >
        <code>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {showLineNumbers ? (
                <span className="sui-codeblock-lineno" aria-hidden="true">
                  {lineIndex + 1}
                </span>
              ) : null}
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                  {token.text}
                </span>
              ))}
              {lineIndex < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export type CodeBlockHeaderProps = ComponentProps<"div">;

/** Custom header row slot for code block compositions. */
export function CodeBlockHeader({ className, ...props }: CodeBlockHeaderProps) {
  useInjectUiCss();
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  return (
    <div
      data-slot="code-block-header"
      className={cn("sui-codeblock-header", className)}
      {...props}
    />
  );
}

export type CodeBlockFilenameProps = Omit<ComponentProps<"span">, "children"> & {
  name: string;
  icon?: ReactNode;
};

/** Monospace filename chip for code block headers. */
export function CodeBlockFilename({ name, icon, className, ...props }: CodeBlockFilenameProps) {
  useInjectUiCss();
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  return (
    <span
      data-slot="code-block-filename"
      className={cn("sui-codeblock-filename", className)}
      {...props}
    >
      {icon != null ? (
        <span aria-hidden="true">{icon}</span>
      ) : null}
      {name}
    </span>
  );
}

export type CodeBlockGroupItem = {
  id: string;
  label: string;
  code: string;
  language?: string;
  filename?: string;
};

export type CodeBlockTabsProps = Omit<ComponentProps<"div">, "children"> & {
  items: readonly { id: string; label: string }[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
};

/** Tab strip for switching between grouped code blocks. */
export function CodeBlockTabs({
  items,
  activeId,
  onActiveIdChange,
  className,
  onKeyDown,
  ...props
}: CodeBlockTabsProps) {
  useInjectUiCss();
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (items.length === 0) return;
    const index = Math.max(0, items.findIndex((item) => item.id === activeId));
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    event.preventDefault();
    onActiveIdChange(items[next]!.id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      data-slot="code-block-tabs"
      className={cn("sui-codeblock-tabs", className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(el) => {
            tabRefs.current[index] = el;
          }}
          type="button"
          role="tab"
          data-slot="code-block-tab"
          className="sui-codeblock-tab"
          aria-selected={item.id === activeId}
          onClick={() => onActiveIdChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type CodeBlockGroupProps = Omit<ComponentProps<"div">, "children"> & {
  items: readonly CodeBlockGroupItem[];
  activeId?: string;
  defaultActiveId?: string;
  onActiveIdChange?: (id: string) => void;
  showLineNumbers?: boolean;
  highlight?: CodeBlockHighlighter;
};

/** Tabbed group of related code blocks sharing one frame. */
export function CodeBlockGroup({
  items,
  activeId: controlledActiveId,
  defaultActiveId,
  onActiveIdChange,
  showLineNumbers,
  highlight,
  className,
  ...props
}: CodeBlockGroupProps) {
  useInjectUiCss();
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  const isControlled = controlledActiveId !== undefined;
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState(
    () => defaultActiveId ?? items[0]?.id ?? "",
  );
  const currentId = isControlled ? controlledActiveId : uncontrolledActiveId;
  const active = items.find((item) => item.id === currentId) ?? items[0];

  function setActive(id: string) {
    if (!isControlled) setUncontrolledActiveId(id);
    onActiveIdChange?.(id);
  }

  return (
    <div
      data-slot="code-block-group"
      className={cn("sui-codeblock-group", className)}
      {...props}
    >
      {items.length ? (
        <CodeBlockHeader className="sui-codeblock-group-header">
          <CodeBlockTabs
            items={items.map(({ id, label }) => ({ id, label }))}
            activeId={active!.id}
            onActiveIdChange={setActive}
          />
          {active!.filename !== undefined ? <CodeBlockFilename name={active!.filename} /> : null}
        </CodeBlockHeader>
      ) : null}
      {active ? (
        <CodeBlock
          code={active.code}
          language={active.language}
          showLineNumbers={showLineNumbers}
          highlight={highlight}
        />
      ) : null}
    </div>
  );
}
