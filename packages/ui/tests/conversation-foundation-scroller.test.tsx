/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerState,
  useMessageVisibility,
  type MessageScrollerCommands,
} from "../src/chat/MessageScroller";
import { CONVERSATION_FOUNDATION_CSS_ID } from "../src/chat/conversationFoundationCss";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Metrics = { scrollHeight: number; clientHeight: number; scrollTop: number };

const metricsByElement = new WeakMap<HTMLElement, Metrics>();
const geometryByMessageId = new Map<string, { top: number; height: number }>();
let defaultMetrics: Metrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
// Simulates the transcript sitting below page chrome: rect coordinates carry
// this offset while scroll-content coordinates never do.
let pageOffset = 0;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
const originalResizeObserver = globalThis.ResizeObserver;

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
  for (const property of ["scrollHeight", "clientHeight", "scrollTop", "offsetTop", "offsetHeight", "getBoundingClientRect"]) {
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
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      const id = (this as HTMLElement).dataset.messageId;
      return (id && geometryByMessageId.get(id)?.top) || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const id = (this as HTMLElement).dataset.messageId;
      return (id && geometryByMessageId.get(id)?.height) || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const base = { left: 0, right: 0, width: 0, x: 0, toJSON: () => ({}) };
      if (this.dataset.slot === "message-scroller-viewport") {
        const height = this.clientHeight;
        return { ...base, top: pageOffset, bottom: pageOffset + height, height, y: pageOffset } as DOMRect;
      }
      const id = this.dataset.messageId;
      const geom = id ? geometryByMessageId.get(id) : undefined;
      if (geom) {
        const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
        const scrollTop = viewport?.scrollTop ?? 0;
        const top = pageOffset + geom.top - scrollTop;
        return { ...base, top, bottom: top + geom.height, height: geom.height, y: top } as DOMRect;
      }
      return { ...base, top: 0, bottom: 0, height: 0, y: 0 } as DOMRect;
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
  pageOffset = 0;
  geometryByMessageId.clear();
  resizeCallbacks.clear();
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
  document
    .querySelectorAll(`style[data-smithers-ui-lane="${CONVERSATION_FOUNDATION_CSS_ID}"]`)
    .forEach((element) => element.remove());
});

async function render(element: ReactElement, metrics: Metrics): Promise<void> {
  defaultMetrics = { ...metrics };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(element));
  metricsByElement.set(getViewport(), { ...metrics, scrollTop: getViewport().scrollTop });
}

function getViewport(): HTMLDivElement {
  return container!.querySelector<HTMLDivElement>('[data-slot="message-scroller-viewport"]')!;
}

function getItem(messageId: string): HTMLElement {
  return container!.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)!;
}

function metrics(): Metrics {
  return metricsByElement.get(getViewport())!;
}

async function scroll(): Promise<void> {
  await act(async () => getViewport().dispatchEvent(new Event("scroll", { bubbles: true })));
}

describe("MessageScroller compound", () => {
  test("viewport is a labeled keyboard region; content defaults to role=log", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    const viewport = getViewport();
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-label")).toBe("Conversation messages");
    expect(viewport.tabIndex).toBe(0);
    const content = container!.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')!;
    expect(content.getAttribute("role")).toBe("log");
    const item = getItem("m1");
    expect(item.className).toContain("sui-msg-scroller-item");
    expect(item.style.getPropertyValue("--sui-msg-intrinsic")).toBe("96px");
  });

  test("content role is overridable and items accept a custom intrinsic size", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent role="list">
            <MessageScrollerItem messageId="m1" intrinsicSize={140}>
              hello
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(
      container!.querySelector('[data-slot="message-scroller-content"]')!.getAttribute("role"),
    ).toBe("list");
    expect(getItem("m1").style.getPropertyValue("--sui-msg-intrinsic")).toBe("140px");
  });

  test("scrollAnchor=bottom pins on mount and follows content growth", async () => {
    const states: { atTop: boolean; atBottom: boolean; following: boolean }[] = [];
    function Probe() {
      states.push(useMessageScrollerState());
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(getViewport().scrollTop).toBe(1000);
    expect(states.at(-1)!.following).toBe(true);

    metrics().scrollHeight = 1200;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    const callback = resizeCallbacks.get(content)!;
    await act(async () => callback([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(1200);
  });

  test("scrollAnchor 'none' (the upstream default) never autoscrolls", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 300 },
    );
    expect(getViewport().scrollTop).toBe(300);
  });

  test("initialMessageId restores with the previous-item peek at mount", async () => {
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            <MessageScrollerItem messageId="target">target</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(getViewport().scrollTop).toBe(300 - 56);
  });

  test("a missing initialMessageId falls back to the anchor and retries on registration", async () => {
    const view = (withTarget: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            {withTarget ? <MessageScrollerItem messageId="target">target</MessageScrollerItem> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(300 - 56);
  });

  test("scrollToMessage returns false for unregistered ids and jumps with peek", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    geometryByMessageId.set("m2", { top: 420, height: 80 });
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    let result = false;
    await act(async () => {
      result = commands!.scrollToMessage("missing");
    });
    expect(result).toBe(false);
    await act(async () => {
      result = commands!.scrollToMessage("m2");
    });
    expect(result).toBe(true);
    expect(getViewport().scrollTop).toBe(420 - 56);
    await act(async () => {
      commands!.scrollToMessage("m2", { peek: false });
    });
    expect(getViewport().scrollTop).toBe(420);
  });

  test("jump/restore targets are independent of page layout (viewport is not an offsetParent)", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    pageOffset = 240;
    geometryByMessageId.set("m2", { top: 420, height: 80 });
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    // Real-browser layout: the viewport is statically positioned, so the
    // item's offsetParent is a higher ancestor (here body) and offsetTop
    // resolves in document space (page offset included).
    const item = getItem("m2");
    Object.defineProperty(item, "offsetTop", { configurable: true, get: () => 240 + 420 });
    Object.defineProperty(item, "offsetParent", { configurable: true, get: () => document.body });
    let result = false;
    await act(async () => {
      result = commands!.scrollToMessage("m2");
    });
    expect(result).toBe(true);
    expect(getViewport().scrollTop).toBe(420 - 56);
  });

  test("a pending restore is cancelled by the first user scroll gesture", async () => {
    const view = (withTarget: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            {withTarget ? <MessageScrollerItem messageId="target">target</MessageScrollerItem> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    // Scrollbar-drag style gesture: a bare scroll event away from the anchor.
    metrics().scrollTop = 400;
    await scroll();
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(400);
  });

  test("jumping to a mid-transcript message disengages follow; later commits do not yank to bottom", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 500, height: 80 });
    const view = (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>
    );
    await render(view, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    expect(latestState!.following).toBe(true);
    await act(async () => {
      commands!.scrollToMessage("m2");
    });
    expect(getViewport().scrollTop).toBe(500 - 56);
    expect(latestState!.following).toBe(false);
    // A later React commit must not re-pin the viewport to the bottom.
    await act(async () => root!.render(view));
    expect(getViewport().scrollTop).toBe(500 - 56);
  });

  test("jumping to a message at the very end clamps to the max scroll and keeps following", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 880, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    await act(async () => {
      commands!.scrollToMessage("m2");
    });
    expect(getViewport().scrollTop).toBe(800);
    expect(latestState!.following).toBe(true);
  });

  test("scrollToTop/scrollToBottom drive the viewport through commands", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 300 },
    );
    await act(async () => commands!.scrollToBottom());
    expect(getViewport().scrollTop).toBe(1000);
    await act(async () => commands!.scrollToTop());
    expect(getViewport().scrollTop).toBe(0);
  });

  test("prepended items preserve position while not following", async () => {
    const view = (ids: string[]) => (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {ids.map((id) => (
              <MessageScrollerItem key={id} messageId={id}>
                {id}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(["a", "b"]), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    metrics().scrollTop = 400;
    await scroll();
    metrics().scrollHeight = 1200;
    await act(async () => root!.render(view(["older", "a", "b"])));
    expect(getViewport().scrollTop).toBe(600);
  });

  test("useMessageVisibility falls back to geometry without IntersectionObserver", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const visible: Record<string, boolean> = {};
    function Probe() {
      visible.a = useMessageVisibility("a");
      visible.b = useMessageVisibility("b");
      return null;
    }
    geometryByMessageId.set("a", { top: 0, height: 100 });
    geometryByMessageId.set("b", { top: 900, height: 100 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="a">a</MessageScrollerItem>
              <MessageScrollerItem messageId="b">b</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <Probe />
        </MessageScrollerProvider>,
        { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
      );
      expect(visible.a).toBe(true);
      expect(visible.b).toBe(false);
      metrics().scrollTop = 850;
      await scroll();
      expect(visible.a).toBe(false);
      expect(visible.b).toBe(true);
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("visibility treats an item filling the viewport as visible", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const visible: Record<string, boolean> = {};
    function Probe() {
      visible.big = useMessageVisibility("big");
      return null;
    }
    geometryByMessageId.set("big", { top: 0, height: 2000 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="big">big</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <Probe />
        </MessageScrollerProvider>,
        { scrollHeight: 2000, clientHeight: 200, scrollTop: 100 },
      );
      expect(visible.big).toBe(true);
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("MessageScrollerButton hides at the latest position and jumps on click", async () => {
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(container!.querySelector('[data-slot="message-scroller-button"]')).toBeNull();
    metrics().scrollTop = 200;
    await scroll();
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(getViewport().scrollTop).toBe(1000);
  });

  test("a message-targeted button hides while its message is visible", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    geometryByMessageId.set("m2", { top: 700, height: 100 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
              <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton target={{ messageId: "m2" }} behavior="auto" />
        </MessageScrollerProvider>,
        { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
      );
      const button = container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
      expect(button).not.toBeNull();
      await act(async () => button.click());
      expect(getViewport().scrollTop).toBe(700 - 56);
      // The jump scrolls the message into view: the affordance hides itself.
      expect(container!.querySelector('[data-slot="message-scroller-button"]')).toBeNull();
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("renders under the dark theme", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">dark</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 50 },
    );
    const button = container!.querySelector<HTMLElement>('[data-slot="message-scroller-button"]')!;
    expect(getComputedStyle(button).color).toBe("#f4f4f5");
  });
});
