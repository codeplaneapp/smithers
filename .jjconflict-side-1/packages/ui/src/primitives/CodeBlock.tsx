/** @jsxImportSource react */
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "../cn";
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
