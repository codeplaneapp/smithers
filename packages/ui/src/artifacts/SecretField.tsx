/** @jsxImportSource react */
import { useState, type ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CODING_ARTIFACTS_CSS_ID, artifactsCss } from "./artifactsCss";

export type SecretFieldProps = Omit<ComponentProps<"span">, "children"> & {
  value: string;
  revealed?: boolean;
  defaultRevealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  /** Extra accessible context appended to the toggle/copy labels. */
  label?: string;
  /** Fixed bullet count shown while masked (default 8); never tracks length. */
  maskLength?: number;
  onCopy?: (value: string) => void;
};

/**
 * Redacted secret display. While masked the secret string is NOT present
 * anywhere in the DOM — only a fixed-length bullet run. Reveal is a toggle;
 * copy goes through the callback (or clipboard) WITHOUT revealing.
 */
export function SecretField({
  value,
  revealed: controlledRevealed,
  defaultRevealed = false,
  onRevealedChange,
  label,
  maskLength = 8,
  onCopy,
  className,
  ...props
}: SecretFieldProps) {
  useInjectUiCss();
  useInjectLaneCss(CODING_ARTIFACTS_CSS_ID, artifactsCss);
  const [uncontrolledRevealed, setUncontrolledRevealed] = useState(defaultRevealed);
  const isControlled = controlledRevealed !== undefined;
  const revealed = isControlled ? controlledRevealed : uncontrolledRevealed;
  const hasClipboard =
    typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const canCopy = onCopy !== undefined || hasClipboard;
  const context = label !== undefined ? ` ${label}` : "";

  function toggle() {
    const next = !revealed;
    if (!isControlled) setUncontrolledRevealed(next);
    onRevealedChange?.(next);
  }

  function copy() {
    if (onCopy) onCopy(value);
    else if (hasClipboard) void navigator.clipboard.writeText(value);
  }

  return (
    <span
      data-slot="secret-field"
      data-revealed={revealed ? "true" : "false"}
      className={cn("sui-secret", className)}
      {...props}
    >
      {revealed ? (
        <span className="sui-secret-value">{value}</span>
      ) : (
        <>
          <span className="sui-secret-mask" aria-hidden="true">
            {"•".repeat(Math.max(1, maskLength))}
          </span>
          <span className="sui-sr-only">Hidden secret{context}</span>
        </>
      )}
      <button
        type="button"
        data-slot="secret-field-toggle"
        className="sui-secret-toggle"
        aria-pressed={revealed}
        aria-label={revealed ? `Hide secret${context}` : `Reveal secret${context}`}
        onClick={toggle}
      >
        {revealed ? "Hide" : "Reveal"}
      </button>
      {canCopy ? (
        <button
          type="button"
          data-slot="secret-field-copy"
          className="sui-secret-copy"
          aria-label={`Copy secret${context}`}
          onClick={copy}
        >
          Copy
        </button>
      ) : null}
    </span>
  );
}
