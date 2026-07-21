/** @jsxImportSource react */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type ReactNode,
  type Ref,
  type RefAttributes,
} from "react";
import { cn } from "../cn";
import { prefersReducedMotion, useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss } from "./conversationFoundationCss";

/* -------------------------------------------------------------------------- */
/* Frozen public types                                                        */
/* -------------------------------------------------------------------------- */

export type MessageScrollerCommands = {
  scrollToBottom(behavior?: ScrollBehavior): void;
  scrollToTop(behavior?: ScrollBehavior): void;
  /** Jump so the message's top sits `peekPx` below the viewport top. */
  scrollToMessage(messageId: string, opts?: { behavior?: ScrollBehavior; peek?: boolean }): boolean;
};

export type MessageScrollerProviderProps = {
  /** 'bottom' pins and follows growth; 'none' (upstream default) never autoscrolls. */
  scrollAnchor?: "bottom" | "none";
  streaming?: boolean;
  /** Saved-transcript restore: anchor this registered message on mount. */
  initialMessageId?: string;
  bottomThreshold?: number;
  /** Previous-item peek (px) applied on jump/restore. */
  peekPx?: number;
  onFollowChange?: (following: boolean) => void;
  children: ReactNode;
};

export type MessageScrollerViewportProps = Omit<ComponentProps<"div">, "onScroll"> & {
  /** Edge fade masks driven by scroll position. */
  fade?: boolean;
};

export type MessageScrollerContentProps = ComponentProps<"div">;

export type MessageScrollerItemProps = ComponentProps<"div"> & {
  /** Stable message identity used by jump/restore/visibility. */
  messageId: string;
  /** Placeholder height hint for content-visibility (default 96). */
  intrinsicSize?: number;
};

export type MessageScrollerButtonProps = Omit<ComponentProps<"button">, "onClick"> & {
  target?: "latest" | { messageId: string };
  behavior?: ScrollBehavior;
};

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

/* -------------------------------------------------------------------------- */
/* Provider internals                                                         */
/* -------------------------------------------------------------------------- */

type ScrollSnapshot = {
  firstItemKey: string | number | undefined;
  scrollHeight: number;
  scrollTop: number;
};

type ViewportState = { atTop: boolean; atBottom: boolean; following: boolean };

type ScrollerContextValue = {
  commands: MessageScrollerCommands;
  isFollowing: () => boolean;
  registerViewport: (el: HTMLDivElement | null) => void;
  handleViewportScroll: () => void;
  registerItem: (messageId: string, el: HTMLElement | null) => void;
  subscribeState: (listener: () => void) => () => void;
  getState: () => ViewportState;
  subscribeVisibility: (messageId: string, listener: () => void) => () => void;
  isMessageVisible: (messageId: string) => boolean;
};

const ScrollerContext = createContext<ScrollerContextValue | null>(null);

function useScrollerContext(part: string): ScrollerContextValue {
  const ctx = useContext(ScrollerContext);
  if (!ctx) throw new Error(`${part} must be used inside <MessageScrollerProvider>`);
  return ctx;
}

function useScrollerLaneCss(): void {
  useInjectUiCss();
  useInjectLaneCss(CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss);
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

/** Internal-only extension used by the flat compat wrapper (legacy prop). */
type InternalProviderProps = MessageScrollerProviderProps & { firstItemKey?: string | number };

function MessageScrollerProviderImpl({
  scrollAnchor = "none",
  streaming: _streaming = false,
  initialMessageId,
  bottomThreshold = 24,
  peekPx = 56,
  onFollowChange,
  firstItemKey,
  children,
}: InternalProviderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());
  const mountedRef = useRef(false);
  const anchoringRef = useRef(scrollAnchor === "bottom");
  const followingRef = useRef(scrollAnchor === "bottom");
  const ignoreScrollUntilBottomRef = useRef(false);
  const restorePendingRef = useRef(initialMessageId !== undefined);
  const snapshotRef = useRef<ScrollSnapshot>({ firstItemKey, scrollHeight: 0, scrollTop: 0 });
  const previousAnchorRef = useRef(scrollAnchor);
  const onFollowChangeRef = useRef(onFollowChange);
  const thresholdRef = useRef(bottomThreshold);
  const peekPxRef = useRef(peekPx);
  const firstItemKeyRef = useRef(firstItemKey);
  const stateRef = useRef<ViewportState>({
    atTop: true,
    atBottom: true,
    following: scrollAnchor === "bottom",
  });
  const stateListenersRef = useRef(new Set<() => void>());
  const visibleRef = useRef(new Set<string>());
  const visibilityListenersRef = useRef(new Map<string, Set<() => void>>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  anchoringRef.current = scrollAnchor === "bottom";
  onFollowChangeRef.current = onFollowChange;
  thresholdRef.current = bottomThreshold;
  peekPxRef.current = peekPx;
  firstItemKeyRef.current = firstItemKey;

  const emitState = useCallback((patch: Partial<ViewportState>) => {
    const next = { ...stateRef.current, ...patch };
    if (
      next.atTop === stateRef.current.atTop &&
      next.atBottom === stateRef.current.atBottom &&
      next.following === stateRef.current.following
    ) {
      return;
    }
    stateRef.current = next;
    for (const listener of stateListenersRef.current) listener();
  }, []);

  const measure = useCallback(
    (viewport: HTMLDivElement) => {
      const bottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= thresholdRef.current;
      emitState({ atBottom: bottom, atTop: viewport.scrollTop <= 0 });
      return bottom;
    },
    [emitState],
  );

  const setFollowing = useCallback(
    (next: boolean, notify = true) => {
      const resolved = anchoringRef.current ? next : false;
      if (followingRef.current === resolved) return;
      followingRef.current = resolved;
      emitState({ following: resolved });
      if (notify && mountedRef.current) {
        onFollowChangeRef.current?.(resolved);
      }
    },
    [emitState],
  );

  const firstDomItemId = useCallback((): string | undefined => {
    const viewport = viewportRef.current;
    const first = viewport?.querySelector<HTMLElement>("[data-message-id]");
    return first?.dataset.messageId;
  }, []);

  const remember = useCallback((viewport: HTMLDivElement) => {
    snapshotRef.current = {
      firstItemKey: firstItemKeyRef.current ?? firstDomItemId(),
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    };
  }, [firstDomItemId]);

  const resolveBehavior = useCallback((behavior: ScrollBehavior): ScrollBehavior => {
    return behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior;
  }, []);

  const scrollViewportTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const resolved = resolveBehavior(behavior);
      if (resolved === "auto") {
        viewport.scrollTop = top;
      } else if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior: resolved });
      } else {
        viewport.scrollTop = top;
      }
    },
    [resolveBehavior],
  );

  /**
   * Item top in scroll-content coordinates. Rect math is positioning
   * independent: the viewport is statically positioned, so it is NOT the
   * item's offsetParent and an offsetTop walk would leak page-level offsets.
   */
  const itemTopWithinViewport = useCallback((el: HTMLElement): number => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  }, []);

  /* ---- visibility tracking ----------------------------------------------- */

  const setMessageVisible = useCallback((messageId: string, visible: boolean) => {
    const set = visibleRef.current;
    const has = set.has(messageId);
    if (has === visible) return;
    if (visible) set.add(messageId);
    else set.delete(messageId);
    const listeners = visibilityListenersRef.current.get(messageId);
    if (listeners) for (const listener of listeners) listener();
  }, []);

  const recomputeVisibilityGeometric = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const viewTop = viewport.scrollTop;
    const viewBottom = viewTop + viewport.clientHeight;
    for (const [id, el] of itemsRef.current) {
      const top = itemTopWithinViewport(el);
      const height = el.offsetHeight;
      const bottom = top + height;
      const overlap = Math.min(bottom, viewBottom) - Math.max(top, viewTop);
      const fillsViewport = top <= viewTop && bottom >= viewBottom && height >= viewport.clientHeight;
      const visible = fillsViewport || (height > 0 && overlap >= height * 0.5);
      setMessageVisible(id, visible);
    }
  }, [itemTopWithinViewport, setMessageVisible]);

  /** Geometric fallback must refresh after programmatic jumps (no scroll event). */
  const refreshVisibilityFallback = useCallback(() => {
    if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
  }, [recomputeVisibilityGeometric]);

  const maxScrollTop = useCallback((viewport: HTMLDivElement): number => {
    return Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      restorePendingRef.current = false;
      ignoreScrollUntilBottomRef.current = anchoringRef.current;
      scrollViewportTo(viewport.scrollHeight, behavior);
      const bottom = measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      if (bottom && anchoringRef.current) {
        ignoreScrollUntilBottomRef.current = false;
        setFollowing(true);
      }
    },
    [measure, remember, refreshVisibilityFallback, scrollViewportTo, setFollowing],
  );

  const scrollToTop = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      restorePendingRef.current = false;
      ignoreScrollUntilBottomRef.current = false;
      scrollViewportTo(0, behavior);
      measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      // Follow survives only when the whole transcript fits the viewport.
      if (anchoringRef.current) setFollowing(maxScrollTop(viewport) <= thresholdRef.current);
    },
    [maxScrollTop, measure, remember, refreshVisibilityFallback, scrollViewportTo, setFollowing],
  );

  const scrollToMessage = useCallback(
    (messageId: string, opts?: { behavior?: ScrollBehavior; peek?: boolean }): boolean => {
      const viewport = viewportRef.current;
      const el = itemsRef.current.get(messageId);
      if (!viewport || !el) return false;
      restorePendingRef.current = false;
      ignoreScrollUntilBottomRef.current = false;
      const peek = opts?.peek ?? true;
      const maxTop = maxScrollTop(viewport);
      const top = Math.min(
        Math.max(itemTopWithinViewport(el) - (peek ? peekPxRef.current : 0), 0),
        maxTop,
      );
      scrollViewportTo(top, opts?.behavior ?? "auto");
      measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      // Derive follow from the deterministic target, not the pre-scroll position:
      // a smooth scroll has not settled yet when this runs.
      if (anchoringRef.current) setFollowing(maxTop - top <= thresholdRef.current);
      return true;
    },
    [itemTopWithinViewport, maxScrollTop, measure, remember, refreshVisibilityFallback, scrollViewportTo, setFollowing],
  );

  const commandsRef = useRef<MessageScrollerCommands>({ scrollToBottom, scrollToTop, scrollToMessage });
  commandsRef.current = { scrollToBottom, scrollToTop, scrollToMessage };

  /* ---- saved-transcript restore ------------------------------------------ */

  const tryRestore = useCallback(() => {
    if (!restorePendingRef.current || initialMessageId === undefined) return;
    const viewport = viewportRef.current;
    const el = itemsRef.current.get(initialMessageId);
    if (!viewport || !el) return;
    restorePendingRef.current = false;
    ignoreScrollUntilBottomRef.current = false;
    viewport.scrollTop = Math.max(itemTopWithinViewport(el) - peekPxRef.current, 0);
    // A restored position is a deliberate mid-transcript anchor: stop following.
    setFollowing(false);
    measure(viewport);
    remember(viewport);
    refreshVisibilityFallback();
  }, [initialMessageId, itemTopWithinViewport, measure, remember, refreshVisibilityFallback, setFollowing]);

  const observeItem = useCallback(
    (messageId: string, el: HTMLElement | null) => {
      const observer = observerRef.current;
      if (!observer) return;
      if (el) observer.observe(el);
      else {
        const previous = itemsRef.current.get(messageId);
        if (previous) observer.unobserve(previous);
      }
    },
    [],
  );

  /* ---- registration ------------------------------------------------------- */

  const registerItem = useCallback(
    (messageId: string, el: HTMLElement | null) => {
      if (el) {
        itemsRef.current.set(messageId, el);
        observeItem(messageId, el);
        tryRestore();
        if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
      } else {
        observeItem(messageId, null);
        itemsRef.current.delete(messageId);
        setMessageVisible(messageId, false);
      }
    },
    [observeItem, recomputeVisibilityGeometric, setMessageVisible, tryRestore],
  );

  const cancelProgrammaticScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    restorePendingRef.current = false;
    ignoreScrollUntilBottomRef.current = false;
    const bottom = measure(viewport);
    remember(viewport);
    if (anchoringRef.current) setFollowing(bottom);
  }, [measure, remember, setFollowing]);

  const onViewportKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) cancelProgrammaticScroll();
    },
    [cancelProgrammaticScroll],
  );

  const registerViewport = useCallback(
    (el: HTMLDivElement | null) => {
      const previous = viewportRef.current;
      if (previous && previous !== el) {
        previous.removeEventListener("wheel", cancelProgrammaticScroll);
        previous.removeEventListener("touchmove", cancelProgrammaticScroll);
        previous.removeEventListener("keydown", onViewportKeyDown);
      }
      viewportRef.current = el;
      if (el) {
        el.addEventListener("wheel", cancelProgrammaticScroll, { passive: true });
        el.addEventListener("touchmove", cancelProgrammaticScroll, { passive: true });
        el.addEventListener("keydown", onViewportKeyDown);
      }
    },
    [cancelProgrammaticScroll, onViewportKeyDown],
  );

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previousTop = snapshotRef.current.scrollTop;
    const bottom = measure(viewport);
    // A scroll that leaves the anchor pin while a restore is pending is a user
    // gesture (scrollbar drags surface only as scroll events): cancel retrying.
    if (restorePendingRef.current && !bottom) restorePendingRef.current = false;
    remember(viewport);
    if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
    if (!anchoringRef.current) return;
    if (ignoreScrollUntilBottomRef.current) {
      if (bottom) {
        ignoreScrollUntilBottomRef.current = false;
        setFollowing(true);
      } else if (viewport.scrollTop < previousTop) {
        // The programmatic jump lost ground: the user grabbed the scrollbar
        // mid-flight (wheel/touch/keys cancel via cancelProgrammaticScroll).
        // Reconcile follow with the position instead of staying stuck.
        ignoreScrollUntilBottomRef.current = false;
        setFollowing(false);
      }
      return;
    }
    setFollowing(bottom);
  }, [measure, remember, recomputeVisibilityGeometric, setFollowing]);

  /* ---- mount + per-commit scroll maintenance ------------------------------ */

  // Every commit may change intrinsic content height, even when props retain identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!mountedRef.current) {
      if (restorePendingRef.current && initialMessageId !== undefined) {
        const el = itemsRef.current.get(initialMessageId);
        if (el) {
          tryRestore();
        } else if (anchoringRef.current) {
          // Saved id not mounted yet: fall back to the anchor, keep retrying on
          // later registrations until a user gesture or explicit command cancels.
          viewport.scrollTop = viewport.scrollHeight;
        }
      } else if (anchoringRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        followingRef.current = true;
      } else {
        followingRef.current = false;
      }
      emitState({ following: followingRef.current });
      measure(viewport);
      remember(viewport);
      mountedRef.current = true;
      return;
    }

    const previous = snapshotRef.current;
    const anchorChanged = previousAnchorRef.current !== scrollAnchor;
    previousAnchorRef.current = scrollAnchor;

    if (!anchoringRef.current) {
      ignoreScrollUntilBottomRef.current = false;
      setFollowing(false);
    } else if (anchorChanged) {
      const wasAtBottom =
        previous.scrollHeight - previous.scrollTop - viewport.clientHeight <= thresholdRef.current;
      if (wasAtBottom) setFollowing(true);
    }

    const currentFirstKey = firstItemKeyRef.current ?? firstDomItemId();
    const firstItemChanged = !Object.is(previous.firstItemKey, currentFirstKey);
    if (firstItemChanged && !followingRef.current) {
      viewport.scrollTop += viewport.scrollHeight - previous.scrollHeight;
    } else if (anchoringRef.current && followingRef.current && !restorePendingRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    measure(viewport);
    remember(viewport);
  });

  /* ---- content growth re-pin + visibility fallback ------------------------ */

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = viewport?.firstElementChild;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // An in-flight programmatic jump-to-latest keeps re-targeting the moving
      // bottom, so streaming growth mid-flight cannot strand the jump.
      const jumpingToLatest = ignoreScrollUntilBottomRef.current;
      if (
        anchoringRef.current &&
        (followingRef.current || jumpingToLatest) &&
        !restorePendingRef.current
      ) {
        viewport.scrollTop = viewport.scrollHeight;
        if (jumpingToLatest && measure(viewport)) {
          ignoreScrollUntilBottomRef.current = false;
          setFollowing(true);
        }
      }
      measure(viewport);
      remember(viewport);
      if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure, remember, recomputeVisibilityGeometric, setFollowing]);

  useEffect(() => {
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.messageId;
            if (!id) continue;
            // Frozen rule: half-visible OR an oversize item filling the viewport
            // (whose intersectionRatio can never reach the 0.5 threshold).
            const rootHeight = entry.rootBounds?.height ?? 0;
            const fillsViewport =
              rootHeight > 0 && entry.intersectionRect.height >= rootHeight * 0.99;
            setMessageVisible(
              id,
              entry.isIntersecting && (entry.intersectionRatio >= 0.5 || fillsViewport),
            );
          }
        },
        { root: viewportRef.current, threshold: [0, 0.5] },
      );
      observerRef.current = observer;
      for (const el of itemsRef.current.values()) observer.observe(el);
      return () => {
        observer.disconnect();
        observerRef.current = null;
      };
    }
    recomputeVisibilityGeometric();
    window.addEventListener("resize", recomputeVisibilityGeometric);
    return () => window.removeEventListener("resize", recomputeVisibilityGeometric);
  }, [recomputeVisibilityGeometric, setMessageVisible]);

  /* ---- context ------------------------------------------------------------ */

  const contextValue = useMemo<ScrollerContextValue>(
    () => ({
      commands: commandsRef.current,
      isFollowing: () => anchoringRef.current && followingRef.current,
      registerViewport,
      handleViewportScroll: handleScroll,
      registerItem,
      subscribeState: (listener) => {
        stateListenersRef.current.add(listener);
        return () => stateListenersRef.current.delete(listener);
      },
      getState: () => stateRef.current,
      subscribeVisibility: (messageId, listener) => {
        let set = visibilityListenersRef.current.get(messageId);
        if (!set) {
          set = new Set();
          visibilityListenersRef.current.set(messageId, set);
        }
        set.add(listener);
        return () => {
          set!.delete(listener);
        };
      },
      isMessageVisible: (messageId) => visibleRef.current.has(messageId),
    }),
    [registerViewport, registerItem, handleScroll],
  );
  contextValue.commands = commandsRef.current;

  return <ScrollerContext.Provider value={contextValue}>{children}</ScrollerContext.Provider>;
}

/** State + commands context for the conversation scroller compound anatomy. */
export function MessageScrollerProvider(props: MessageScrollerProviderProps) {
  useScrollerLaneCss();
  return <MessageScrollerProviderImpl {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Viewport / Content / Item / Button                                        */
/* -------------------------------------------------------------------------- */

/** Scrollable region (role=region, single tab stop) with optional edge fades. */
export const MessageScrollerViewport: ForwardRefExoticComponent<
  MessageScrollerViewportProps & RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, MessageScrollerViewportProps>(function MessageScrollerViewport(
  { fade = false, className, children, "aria-label": ariaLabel, ...props },
  ref,
) {
  useScrollerLaneCss();
  const { registerViewport, handleViewportScroll } = useScrollerContext("MessageScrollerViewport");
  const { atTop, atBottom } = useMessageScrollerState();
  const composedRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerViewport(el);
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLDivElement | null }).current = el;
    },
    [registerViewport, ref],
  );
  return (
    <div
      ref={composedRef}
      data-slot="message-scroller-viewport"
      className={cn("sui-msg-scroller-viewport", fade && "sui-scroll-fade", className)}
      data-fade-top={atTop ? "false" : "true"}
      data-fade-bottom={atBottom ? "false" : "true"}
      role="region"
      aria-label={ariaLabel ?? "Conversation messages"}
      tabIndex={0}
      onScroll={handleViewportScroll}
      {...props}
    >
      {children}
    </div>
  );
}) as ForwardRefExoticComponent<MessageScrollerViewportProps & RefAttributes<HTMLDivElement>>;

/** Message list container; defaults to role='log' (live-log semantics). */
export function MessageScrollerContent({ className, role, ...props }: MessageScrollerContentProps) {
  useScrollerLaneCss();
  return (
    <div
      data-slot="message-scroller-content"
      role={role ?? "log"}
      className={cn("sui-msg-scroller-content", className)}
      {...props}
    />
  );
}

type ItemStyle = CSSProperties & { "--sui-msg-intrinsic"?: string };

/** One registered message wrapper with content-visibility optimization. */
export function MessageScrollerItem({
  messageId,
  intrinsicSize = 96,
  className,
  style,
  ...props
}: MessageScrollerItemProps) {
  useScrollerLaneCss();
  const { registerItem } = useScrollerContext("MessageScrollerItem");
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerItem(messageId, el),
    [registerItem, messageId],
  );
  const itemStyle: ItemStyle = { ...(style as ItemStyle), "--sui-msg-intrinsic": `${intrinsicSize}px` };
  return (
    <div
      ref={ref}
      data-slot="message-scroller-item"
      data-message-id={messageId}
      className={cn("sui-msg-scroller-item", className)}
      style={itemStyle}
      {...props}
    />
  );
}

function MessageScrollerLatestButton({ behavior = "smooth", className, children, ...props }: MessageScrollerButtonProps) {
  useScrollerLaneCss();
  const { commands } = useScrollerContext("MessageScrollerButton");
  const { atBottom } = useMessageScrollerState();
  if (atBottom) return null;
  return (
    <button
      type="button"
      data-slot="message-scroller-button"
      aria-label="Jump to latest"
      className={cn("sui-msg-scroller-button", className)}
      onClick={() => commands.scrollToBottom(behavior)}
      {...props}
    >
      {children ?? <span aria-hidden="true">↓</span>}
    </button>
  );
}

function MessageScrollerTargetButton({
  target,
  behavior = "smooth",
  className,
  children,
  ...props
}: MessageScrollerButtonProps & { target: { messageId: string } }) {
  useScrollerLaneCss();
  const { commands } = useScrollerContext("MessageScrollerButton");
  const visible = useMessageVisibility(target.messageId);
  if (visible) return null;
  return (
    <button
      type="button"
      data-slot="message-scroller-button"
      aria-label="Jump to message"
      className={cn("sui-msg-scroller-button", className)}
      onClick={() => commands.scrollToMessage(target.messageId, { behavior, peek: true })}
      {...props}
    >
      {children ?? <span aria-hidden="true">↓</span>}
    </button>
  );
}

/** Jump affordance; renders null while already at the target region. */
export function MessageScrollerButton({ target = "latest", ...props }: MessageScrollerButtonProps) {
  if (target === "latest") return <MessageScrollerLatestButton {...props} />;
  return <MessageScrollerTargetButton target={target} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Hooks (pay-for-use subscriptions)                                          */
/* -------------------------------------------------------------------------- */

/** Imperative scroller commands from the ambient provider. */
export function useMessageScroller(): MessageScrollerCommands {
  return useScrollerContext("useMessageScroller").commands;
}

/** Whether a registered message is at least half visible (or fills the viewport). */
export function useMessageVisibility(messageId: string): boolean {
  const { subscribeVisibility, isMessageVisible } = useScrollerContext("useMessageVisibility");
  const subscribe = useCallback(
    (listener: () => void) => subscribeVisibility(messageId, listener),
    [subscribeVisibility, messageId],
  );
  const getSnapshot = useCallback(() => isMessageVisible(messageId), [isMessageVisible, messageId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Viewport position + follow state, subscribed only by callers of this hook. */
export function useMessageScrollerState(): ViewportState {
  const { subscribeState, getState } = useScrollerContext("useMessageScrollerState");
  return useSyncExternalStore(subscribeState, getState, getState);
}

/* -------------------------------------------------------------------------- */
/* Flat compat component (unchanged public surface)                           */
/* -------------------------------------------------------------------------- */

type FlatInnerProps = MessageScrollerProps & { handleRef: Ref<MessageScrollerHandle> };

function FlatScrollerInner({
  fade = true,
  hideJumpToLatest = false,
  jumpToLatestLabel = "Jump to latest",
  streaming = false,
  contentClassName,
  className,
  children,
  handleRef,
  ...props
}: FlatInnerProps) {
  useScrollerLaneCss();
  const ctx = useScrollerContext("MessageScroller");
  const { atBottom, following } = useMessageScrollerState();

  useImperativeHandle(
    handleRef,
    () => ({ scrollToBottom: ctx.commands.scrollToBottom, isFollowing: ctx.isFollowing }),
    [ctx],
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("sui-msg-scroller", className)}
      data-following={following ? "true" : "false"}
      data-streaming={streaming ? "true" : "false"}
      {...(props as ComponentProps<"div">)}
    >
      <MessageScrollerViewport fade={fade}>
        <div
          data-slot="message-scroller-content"
          className={cn("sui-msg-scroller-content", contentClassName)}
        >
          {children}
        </div>
      </MessageScrollerViewport>
      {!atBottom && !hideJumpToLatest ? (
        <button
          type="button"
          data-slot="message-scroller-jump"
          className="sui-msg-scroller-jump"
          aria-label={jumpToLatestLabel}
          onClick={() => ctx.commands.scrollToBottom("smooth")}
        >
          <span aria-hidden="true">↓</span>
        </button>
      ) : null}
    </div>
  );
}

/** Anchored conversation viewport with streaming follow and prepend compensation. */
export const MessageScroller: ForwardRefExoticComponent<
  MessageScrollerProps & RefAttributes<MessageScrollerHandle>
> = forwardRef<MessageScrollerHandle, MessageScrollerProps>(function MessageScroller(
  {
    stickToBottom = true,
    streaming = false,
    bottomThreshold = 24,
    firstItemKey,
    onFollowChange,
    ...rest
  },
  ref,
) {
  useScrollerLaneCss();
  const ambient = useContext(ScrollerContext);
  if (ambient) {
    // Provider/Scroller composition: the ambient provider owns scroll state, so
    // the frame consumes it instead of nesting a shadow provider.
    return <FlatScrollerInner {...rest} streaming={streaming} handleRef={ref} />;
  }
  return (
    <MessageScrollerProviderImpl
      scrollAnchor={stickToBottom ? "bottom" : "none"}
      streaming={streaming}
      bottomThreshold={bottomThreshold}
      firstItemKey={firstItemKey}
      onFollowChange={onFollowChange}
    >
      <FlatScrollerInner {...rest} streaming={streaming} handleRef={ref} />
    </MessageScrollerProviderImpl>
  );
}) as ForwardRefExoticComponent<MessageScrollerProps & RefAttributes<MessageScrollerHandle>>;
