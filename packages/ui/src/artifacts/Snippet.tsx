/** @jsxImportSource react */
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CODING_ARTIFACTS_CSS_ID, artifactsCss } from "./artifactsCss";

export type SnippetProps = Omit<ComponentProps<"div">, "children"> & {
  code: string;
  language?: string;
  onCopyCode?: (code: string) => void;
};

/**
 * One-line command/code chip with a copy affordance. Copy seam matches
 * CodeBlock: onCopyCode wins, else navigator.clipboard when available, else
 * the button is hidden.
 */
export function Snippet({ code, language, onCopyCode, className, ...props }: SnippetProps) {
  useInjectUiCss();
  useInjectLaneCss(CODING_ARTIFACTS_CSS_ID, artifactsCss);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasClipboard =
    typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const canCopy = onCopyCode !== undefined || hasClipboard;

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  function copyCode() {
    if (onCopyCode) onCopyCode(code);
    else if (hasClipboard) void navigator.clipboard.writeText(code);
    setCopied(true);
    if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined;
      setCopied(false);
    }, 2_000);
  }

  return (
    <div
      data-slot="snippet"
      data-language={language}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-snippet", className)}
      {...props}
    >
      <code className="sui-snippet-code">{code}</code>
      {canCopy ? (
        <button
          type="button"
          data-slot="snippet-copy"
          className="sui-snippet-copy"
          aria-label="Copy code"
          onClick={copyCode}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      ) : null}
    </div>
  );
}
