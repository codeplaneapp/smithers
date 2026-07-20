/** @jsxImportSource react */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ForwardRefExoticComponent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefAttributes,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type MessageScrollerHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  isFollowing: () => boolean;
};

export type MessageScrollerProps = Omit<ComponentProps<"div">, "onScroll"> & {
  stickToBottom?: boolean;
  streaming?: boolean;
  bottomThreshold?: number;
  firstItemKey?: string | number;
  fade?: boolean;
  hideJumpToLatest?: boolean;
  jumpToLatestLabel?: string;
  onFollowChange?: (following: boolean) => void;
  contentClassName?: string;
  children?: ReactNode;
};

type ScrollSnapshot = {
  firstItemKey: string | number | undefined;
  scrollHeight: number;
  scrollTop: number;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Anchored conversation viewport with streaming follow and prepend compensation. */
export const MessageScroller: ForwardRefExoticComponent<
  MessageScrollerProps & RefAttributes<MessageScrollerHandle>
> = forwardRef<MessageScrollerHandle, MessageScrollerProps>(
  function MessageScroller(
    {
      stickToBottom = true,
      streaming = false,
      bottomThreshold = 24,
      firstItemKey,
      fade = true,
      hideJumpToLatest = false,
      jumpToLatestLabel = "Jump to latest",
      onFollowChange,
      contentClassName,
      className,
      children,
      ...props
    },
    ref,
  ) {
    useInjectUiCss();
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(false);
    const followingRef = useRef(stickToBottom);
    const ignoreScrollUntilBottomRef = useRef(false);
    const snapshotRef = useRef<ScrollSnapshot>({
      firstItemKey,
      scrollHeight: 0,
      scrollTop: 0,
    });
    const stickToBottomRef = useRef(stickToBottom);
    const previousStickToBottomRef = useRef(stickToBottom);
    const onFollowChangeRef = useRef(onFollowChange);
    const thresholdRef = useRef(bottomThreshold);
    const [atBottom, setAtBottom] = useState(true);
    const [atTop, setAtTop] = useState(true);
    const [following, setFollowingState] = useState(stickToBottom);

    stickToBottomRef.current = stickToBottom;
    onFollowChangeRef.current = onFollowChange;
    thresholdRef.current = bottomThreshold;

    const measure = useCallback((viewport: HTMLDivElement) => {
      const bottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= thresholdRef.current;
      setAtBottom(bottom);
      setAtTop(viewport.scrollTop <= 0);
      return bottom;
    }, []);

    const setFollowing = useCallback((next: boolean, notify = true) => {
      const resolved = stickToBottomRef.current ? next : false;
      if (followingRef.current === resolved) return;
      followingRef.current = resolved;
      setFollowingState(resolved);
      if (notify && mountedRef.current) {
        onFollowChangeRef.current?.(resolved);
      }
    }, []);

    const remember = useCallback(
      (viewport: HTMLDivElement) => {
        snapshotRef.current = {
          firstItemKey,
          scrollHeight: viewport.scrollHeight,
          scrollTop: viewport.scrollTop,
        };
      },
      [firstItemKey],
    );

    const scrollToBottom = useCallback(
      (behavior: ScrollBehavior = "auto") => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const resolvedBehavior = behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior;
        ignoreScrollUntilBottomRef.current = stickToBottomRef.current;
        if (resolvedBehavior === "auto") {
          viewport.scrollTop = viewport.scrollHeight;
        } else if (typeof viewport.scrollTo === "function") {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: resolvedBehavior });
        } else {
          viewport.scrollTop = viewport.scrollHeight;
        }
        const bottom = measure(viewport);
        remember(viewport);
        if (bottom && stickToBottomRef.current) {
          ignoreScrollUntilBottomRef.current = false;
          setFollowing(true);
        }
      },
      [measure, remember, setFollowing],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        isFollowing: () => stickToBottomRef.current && followingRef.current,
      }),
      [scrollToBottom],
    );

    // Every commit may change intrinsic content height, even when props retain identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useLayoutEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      if (!mountedRef.current) {
        if (stickToBottom) {
          viewport.scrollTop = viewport.scrollHeight;
          followingRef.current = true;
          setFollowingState(true);
        } else {
          followingRef.current = false;
          setFollowingState(false);
        }
        measure(viewport);
        remember(viewport);
        mountedRef.current = true;
        return;
      }

      const previous = snapshotRef.current;
      const stickToBottomChanged = previousStickToBottomRef.current !== stickToBottom;
      previousStickToBottomRef.current = stickToBottom;

      if (!stickToBottom) {
        ignoreScrollUntilBottomRef.current = false;
        setFollowing(false);
      } else if (stickToBottomChanged) {
        const wasAtBottom =
          previous.scrollHeight - previous.scrollTop - viewport.clientHeight <= thresholdRef.current;
        if (wasAtBottom) setFollowing(true);
      }

      const firstItemChanged = !Object.is(previous.firstItemKey, firstItemKey);
      if (firstItemChanged && !followingRef.current) {
        viewport.scrollTop += viewport.scrollHeight - previous.scrollHeight;
      } else if (stickToBottom && followingRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      measure(viewport);
      remember(viewport);
    });

    useLayoutEffect(() => {
      const content = contentRef.current;
      const viewport = viewportRef.current;
      if (!content || !viewport || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        if (stickToBottomRef.current && followingRef.current) {
          viewport.scrollTop = viewport.scrollHeight;
        }
        measure(viewport);
        remember(viewport);
      });
      observer.observe(content);
      return () => observer.disconnect();
    }, [measure, remember]);

    const onScroll = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const bottom = measure(viewport);
      remember(viewport);
      if (!stickToBottomRef.current) return;
      if (ignoreScrollUntilBottomRef.current) {
        if (bottom) {
          ignoreScrollUntilBottomRef.current = false;
          setFollowing(true);
        }
        return;
      }
      setFollowing(bottom);
    };

    const cancelProgrammaticScroll = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      ignoreScrollUntilBottomRef.current = false;
      const bottom = measure(viewport);
      remember(viewport);
      if (stickToBottomRef.current) setFollowing(bottom);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown"
      ) {
        cancelProgrammaticScroll();
      }
    };

    return (
      <div
        data-slot="message-scroller"
        className={cn("sui-msg-scroller", className)}
        data-following={following ? "true" : "false"}
        data-streaming={streaming ? "true" : "false"}
        {...props}
      >
        <div
          ref={viewportRef}
          data-slot="message-scroller-viewport"
          className={cn("sui-msg-scroller-viewport", fade && "sui-scroll-fade")}
          data-fade-top={atTop ? "false" : "true"}
          data-fade-bottom={atBottom ? "false" : "true"}
          onScroll={onScroll}
          onWheel={cancelProgrammaticScroll}
          onTouchMove={cancelProgrammaticScroll}
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          <div
            ref={contentRef}
            data-slot="message-scroller-content"
            className={cn("sui-msg-scroller-content", contentClassName)}
          >
            {children}
          </div>
        </div>
        {!atBottom && !hideJumpToLatest ? (
          <button
            type="button"
            data-slot="message-scroller-jump"
            className="sui-msg-scroller-jump"
            aria-label={jumpToLatestLabel}
            onClick={() => scrollToBottom("smooth")}
          >
            <span aria-hidden="true">↓</span>
          </button>
        ) : null}
      </div>
    );
  },
) as ForwardRefExoticComponent<MessageScrollerProps & RefAttributes<MessageScrollerHandle>>;
