/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript, MessageScroller, type MessageScrollerHandle, SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Metrics = { scrollHeight: number; clientHeight: number; scrollTop: number };

const metricsByElement = new WeakMap<HTMLElement, Metrics>();
let defaultMetrics: Metrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
const originalResizeObserver = globalThis.ResizeObserver;
const originalMatchMedia = window.matchMedia;

class ManualResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    resizeCallbacks.set(target, this.callback);
  }
  unobserve(target: Element): void {
    resizeCallbacks.delete(target);
  }
  disconnect(): void {
    for (const [target, callback] of resizeCallbacks) {
      if (callback === this.callback) resizeCallbacks.delete(target);
    }
  }
}

beforeAll(() => {
  for (const property of ["scrollHeight", "clientHeight", "scrollTop"]) {
    originalDescriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));
  }
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.scrollHeight ?? defaultMetrics.scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.clientHeight ?? defaultMetrics.clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.scrollTop ?? defaultMetrics.scrollTop;
    },
    set(value: number) {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return;
      const current = metricsByElement.get(this as HTMLElement) ?? { ...defaultMetrics };
      current.scrollTop = value;
      metricsByElement.set(this as HTMLElement, current);
    },
  });
  globalThis.ResizeObserver = ManualResizeObserver;
});

afterAll(() => {
  for (const [property, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
  globalThis.ResizeObserver = originalResizeObserver;
  window.matchMedia = originalMatchMedia;
});

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mountedRoot = root;
    await act(async () => mountedRoot.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  defaultMetrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
  resizeCallbacks.clear();
  window.matchMedia = originalMatchMedia;
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement, metrics: Metrics): Promise<void> {
  defaultMetrics = { ...metrics };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(element));
  const viewport = getViewport();
  const seeded = { ...metrics, scrollTop: viewport.scrollTop };
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => seeded.scrollHeight,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => seeded.clientHeight,
  });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => seeded.scrollTop,
    set: (value: number) => {
      seeded.scrollTop = value;
    },
  });
  metricsByElement.set(viewport, seeded);
}

function getViewport(): HTMLDivElement {
  return container!.querySelector<HTMLDivElement>('[data-slot="message-scroller-viewport"]')!;
}

function getContent(): HTMLDivElement {
  return container!.querySelector<HTMLDivElement>('[data-slot="message-scroller-content"]')!;
}

function metrics(viewport = getViewport()): Metrics {
  return metricsByElement.get(viewport)!;
}

async function scroll(viewport = getViewport()): Promise<void> {
  await act(async () => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
}

async function fireResize(target = getContent()): Promise<void> {
  const callback = resizeCallbacks.get(target)!;
  await act(async () => callback([], {} as ResizeObserver));
}

describe("MessageScroller", () => {
  test("keyboard: the named scroll region takes focus and cancels follow on PageUp", async () => {
    const changes: boolean[] = [];
    await render(<MessageScroller onFollowChange={(value) => changes.push(value)}>message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    const viewport = getViewport();
    expect(viewport.tabIndex).toBe(0);
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-label")).toBe("Conversation messages");
    await act(async () => viewport.focus());
    expect(document.activeElement).toBe(viewport);

    metrics().scrollTop = 400;
    await act(async () =>
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true })),
    );
    expect(changes).toEqual([false]);
  });

  test("pins to the bottom on mount without reporting an initial follow transition", async () => {
    const changes: boolean[] = [];
    const handle = createRef<MessageScrollerHandle>();
    await render(
      <MessageScroller ref={handle} onFollowChange={(value) => changes.push(value)}>
        message
      </MessageScroller>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );

    expect(getViewport().scrollTop).toBe(1000);
    expect(handle.current?.isFollowing()).toBe(true);
    expect(changes).toEqual([]);
  });

  test("user scroll-away disables following once and reveals the jump affordance", async () => {
    const changes: boolean[] = [];
    await render(<MessageScroller onFollowChange={(value) => changes.push(value)}>message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    metrics().scrollTop = 400;
    await scroll();
    await scroll();

    expect(changes).toEqual([false]);
    expect(container!.querySelector('[data-slot="message-scroller"]')?.getAttribute("data-following")).toBe("false");
    expect(container!.querySelector('[data-slot="message-scroller-jump"]')).not.toBeNull();
  });

  test("content growth while following re-pins through ResizeObserver", async () => {
    await render(<MessageScroller>message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    metrics().scrollHeight = 1200;
    await fireResize();
    expect(getViewport().scrollTop).toBe(1200);
  });

  test("a changed firstItemKey compensates prepended height while not following", async () => {
    const view = (firstItemKey: string) => <MessageScroller firstItemKey={firstItemKey}>message</MessageScroller>;
    await render(view("first"), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    metrics().scrollTop = 400;
    await scroll();
    metrics().scrollHeight = 1200;
    await act(async () => root!.render(view("older")));
    expect(getViewport().scrollTop).toBe(600);
  });

  test("intermediate smooth-scroll events never re-enable or disable following", async () => {
    const changes: boolean[] = [];
    await render(<MessageScroller onFollowChange={(value) => changes.push(value)}>message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    const viewport = getViewport();
    metrics().scrollTop = 400;
    await scroll(viewport);
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: () => {},
    });
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-jump"]')!.click());
    metrics().scrollTop = 500;
    await scroll(viewport);
    expect(changes).toEqual([false]);
    metrics().scrollTop = 800;
    await scroll(viewport);
    expect(changes).toEqual([false, true]);
  });

  test("reduced motion makes jump instant and resumes following", async () => {
    const changes: boolean[] = [];
    window.matchMedia = (() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    })) as typeof window.matchMedia;
    await render(<MessageScroller onFollowChange={(value) => changes.push(value)}>message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 0,
    });
    metrics().scrollTop = 400;
    await scroll();
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-jump"]')!.click());

    expect(getViewport().scrollTop).toBe(1000);
    expect(changes).toEqual([false, true]);
  });

  test("stickToBottom=false never pins or emits follow changes while fades still update", async () => {
    const changes: boolean[] = [];
    await render(
      <MessageScroller stickToBottom={false} onFollowChange={(value) => changes.push(value)}>
        message
      </MessageScroller>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 },
    );
    expect(getViewport().scrollTop).toBe(100);
    expect(getViewport().getAttribute("data-fade-top")).toBe("true");
    expect(getViewport().getAttribute("data-fade-bottom")).toBe("true");
    metrics().scrollTop = 250;
    await scroll();
    expect(changes).toEqual([]);
    expect(container!.querySelector('[data-slot="message-scroller"]')?.getAttribute("data-following")).toBe("false");
  });

  test("enabling stickToBottom at the bottom restores following for later growth", async () => {
    const changes: boolean[] = [];
    const handle = createRef<MessageScrollerHandle>();
    const view = (stickToBottom: boolean) => (
      <MessageScroller ref={handle} stickToBottom={stickToBottom} onFollowChange={(value) => changes.push(value)}>
        message
      </MessageScroller>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });

    expect(handle.current?.isFollowing()).toBe(false);
    await act(async () => root!.render(view(true)));
    expect(handle.current?.isFollowing()).toBe(true);
    expect(changes).toEqual([true]);

    metrics().scrollHeight = 1200;
    await fireResize();
    expect(getViewport().scrollTop).toBe(1200);
  });

  test("disabling stickToBottom reports a real post-mount follow transition", async () => {
    const changes: boolean[] = [];
    const handle = createRef<MessageScrollerHandle>();
    const view = (stickToBottom: boolean) => (
      <MessageScroller ref={handle} stickToBottom={stickToBottom} onFollowChange={(value) => changes.push(value)}>
        message
      </MessageScroller>
    );
    await render(view(true), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    await act(async () => root!.render(view(false)));
    expect(handle.current?.isFollowing()).toBe(false);
    expect(changes).toEqual([false]);
  });

  test("ChatTranscript composes the scroller and forwards pending streaming state", () => {
    const html = renderToStaticMarkup(<ChatTranscript pending>hello</ChatTranscript>);
    expect(html).toContain('data-slot="message-scroller"');
    expect(html).toContain('data-streaming="true"');
    expect(html).toContain("sui-chat-messages");
  });

  test("ChatTranscript renders its empty state when a boolean child collapses to false", () => {
    const messages: string[] = [];
    const html = renderToStaticMarkup(
      <ChatTranscript empty="No messages">
        {messages.length > 0 && messages.map((message) => <div key={message}>{message}</div>)}
      </ChatTranscript>,
    );
    expect(html).toContain("No messages");
    expect(html).toContain("sui-chat-empty");
  });

  test("renders under the dark theme", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(<MessageScroller stickToBottom={false}>dark message</MessageScroller>, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100,
    });
    const jump = container!.querySelector<HTMLElement>('[data-slot="message-scroller-jump"]')!;
    expect(getComputedStyle(jump).color).toBe("#d6deeb");
  });
});
