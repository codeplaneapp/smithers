/** @jsxImportSource react */
import type { ComponentProps, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ChatComposerProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
  placeholder?: string;
  status?: ReactNode;
  actions?: ReactNode;
  disabled?: boolean;
  /** Fix the glass composer above the viewport bottom, matching Multi chat. */
  docked?: boolean;
  inputAriaLabel?: string;
  submitLabel?: string;
  textareaProps?: Omit<ComponentProps<"textarea">, "value" | "onChange" | "disabled" | "placeholder">;
};

/** Controlled glass chat composer. Enter submits and Shift+Enter inserts a line. */
export function ChatComposer({
  value,
  onValueChange,
  onSubmit,
  placeholder = "Message Smithers…",
  status,
  actions,
  disabled = false,
  docked = false,
  inputAriaLabel = "Chat message",
  submitLabel = "Send message",
  textareaProps,
  className,
  ...props
}: ChatComposerProps) {
  useInjectUiCss();
  const canSubmit = !disabled && value.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextValue = value.trim();
    if (!nextValue || disabled) return;
    void onSubmit(nextValue);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    textareaProps?.onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form
      data-slot="chat-composer"
      data-docked={docked ? "true" : "false"}
      className={cn("sui-chat-composer", className)}
      onSubmit={submit}
      {...props}
    >
      <textarea
        {...textareaProps}
        className={cn("sui-chat-composer-input", textareaProps?.className)}
        aria-label={textareaProps?.["aria-label"] ?? inputAriaLabel}
        rows={textareaProps?.rows ?? 1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="sui-chat-composer-toolbar">
        <div className="sui-chat-composer-status">{status}</div>
        <div className="sui-chat-composer-actions">
          {actions}
          <Button
            type="submit"
            variant="solid"
            size="icon"
            className="sui-chat-composer-send"
            aria-label={submitLabel}
            title={submitLabel}
            disabled={!canSubmit}
          >
            <span aria-hidden="true">↑</span>
          </Button>
        </div>
      </div>
    </form>
  );
}
