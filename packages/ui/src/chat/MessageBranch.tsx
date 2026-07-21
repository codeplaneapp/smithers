/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss } from "./conversationFoundationCss";

type MessageBranchContextValue = {
  count: number;
  index: number;
  setIndex: (index: number) => void;
};

const MessageBranchContext = createContext<MessageBranchContextValue | null>(null);

function useMessageBranch(part: string): MessageBranchContextValue {
  const ctx = useContext(MessageBranchContext);
  if (!ctx) throw new Error(`${part} must be used inside <MessageBranch>`);
  return ctx;
}

function useBranchLaneCss(): void {
  useInjectUiCss();
  useInjectLaneCss(CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss);
}

export type MessageBranchProps = Omit<ComponentProps<"div">, "children"> & {
  /** Total number of alternate responses. */
  count: number;
  /** Controlled active branch index (0-based). */
  index?: number;
  /** Uncontrolled initial branch index. */
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  children?: ReactNode;
};

/** Alternate-response navigator: branch content plus prev/next paging. */
export function MessageBranch({
  count,
  index,
  defaultIndex = 0,
  onIndexChange,
  className,
  children,
  ...props
}: MessageBranchProps) {
  useBranchLaneCss();
  const [internalIndex, setInternalIndex] = useState(defaultIndex);
  const current = index ?? internalIndex;
  const setIndex = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), Math.max(count - 1, 0));
    if (index === undefined) setInternalIndex(clamped);
    onIndexChange?.(clamped);
  };
  return (
    <MessageBranchContext.Provider value={{ count, index: current, setIndex }}>
      <div
        data-slot="message-branch"
        data-branch-index={current}
        data-branch-count={count}
        className={cn("sui-msg-branch", className)}
        {...props}
      >
        {children}
      </div>
    </MessageBranchContext.Provider>
  );
}

/** Region hosting the active branch's rendered response. */
export function MessageBranchContent({ className, ...props }: ComponentProps<"div">) {
  useBranchLaneCss();
  return (
    <div
      data-slot="message-branch-content"
      className={cn("sui-msg-branch-content", className)}
      {...props}
    />
  );
}

/** Grouped prev/next/page controls for branch navigation. */
export function MessageBranchSelector({ className, ...props }: ComponentProps<"div">) {
  useBranchLaneCss();
  return (
    <div
      data-slot="message-branch-selector"
      role="group"
      aria-label="Response branches"
      className={cn("sui-msg-branch-selector", className)}
      {...props}
    />
  );
}

/** Step to the previous branch; disabled at the first branch. */
export function MessageBranchPrevious({ className, onClick, disabled, ...props }: ComponentProps<"button">) {
  useBranchLaneCss();
  const { index, setIndex } = useMessageBranch("MessageBranchPrevious");
  const atStart = index <= 0;
  return (
    <button
      type="button"
      data-slot="message-branch-previous"
      aria-label="Previous response"
      disabled={disabled ?? atStart}
      className={cn("sui-msg-branch-button", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setIndex(index - 1);
      }}
      {...props}
    >
      <span aria-hidden="true">‹</span>
    </button>
  );
}

/** Step to the next branch; disabled at the last branch. */
export function MessageBranchNext({ className, onClick, disabled, ...props }: ComponentProps<"button">) {
  useBranchLaneCss();
  const { count, index, setIndex } = useMessageBranch("MessageBranchNext");
  const atEnd = index >= count - 1;
  return (
    <button
      type="button"
      data-slot="message-branch-next"
      aria-label="Next response"
      disabled={disabled ?? atEnd}
      className={cn("sui-msg-branch-button", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setIndex(index + 1);
      }}
      {...props}
    >
      <span aria-hidden="true">›</span>
    </button>
  );
}

/** Polite '<index+1> of <count>' page indicator. */
export function MessageBranchPage({ className, ...props }: ComponentProps<"span">) {
  useBranchLaneCss();
  const { count, index } = useMessageBranch("MessageBranchPage");
  return (
    <span
      data-slot="message-branch-page"
      aria-live="polite"
      className={cn("sui-msg-branch-page", className)}
      {...props}
    >
      {index + 1} of {count}
    </span>
  );
}
