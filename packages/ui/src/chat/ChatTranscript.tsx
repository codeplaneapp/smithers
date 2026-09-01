/** @jsxImportSource react */
import { Children, type ComponentProps, type ReactNode, type Ref } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss } from "./conversationFoundationCss";
import { ChatMessage } from "./ChatMessage";
import { MessageScroller, type MessageScrollerHandle, type MessageScrollerProps } from "./MessageScroller";

export type ChatTranscriptProps = ComponentProps<"div"> & {
  /** Whether a reply is currently being generated or streamed. */
  pending?: boolean;
  /** Accessible text for the pending assistant bubble. */
  pendingLabel?: string;
  /** Content shown when there are no messages. */
  empty?: ReactNode;
  /** Optional overrides for the internal conversation scroller. */
  scrollerProps?: Omit<MessageScrollerProps, "children" | "contentClassName">;
  /** Imperative access to the internal conversation scroller. */
  scrollerRef?: Ref<MessageScrollerHandle>;
};

/** Scrollable, accessible transcript container for Smithers chat surfaces. */
export function ChatTranscript({
  pending = false,
  pendingLabel,
  empty,
  scrollerProps,
  scrollerRef,
  className,
  children,
  ...props
}: ChatTranscriptProps) {
  useInjectUiCss();
  useInjectLaneCss(CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss);
  const isEmpty = Children.toArray(children).length === 0;
  const internalScrollerProps = scrollerProps as
    | Omit<MessageScrollerProps, "children" | "contentClassName" | "ref">
    | undefined;
  const internalScrollerRef = scrollerRef as ComponentProps<typeof MessageScroller>["ref"];
  return (
    <div
      data-slot="chat-transcript"
      role="log"
      aria-busy={pending}
      className={cn("sui-chat-transcript", className)}
      {...props}
    >
      <MessageScroller
        ref={internalScrollerRef}
        streaming={pending}
        contentClassName="sui-chat-messages"
        {...internalScrollerProps}
      >
        {isEmpty && empty ? <div className="sui-chat-empty">{empty}</div> : children}
        {pending ? <ChatMessage role="assistant" pending pendingLabel={pendingLabel} /> : null}
      </MessageScroller>
    </div>
  );
}
