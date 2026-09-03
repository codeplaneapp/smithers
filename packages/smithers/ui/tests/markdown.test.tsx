import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { markdownBlockParser } from "../src/primitives/markdown";

/**
 * The mixed-block structure and HTML-escaping cases render with
 * `renderToStaticMarkup` (no DOM), the components.test.tsx convention. The
 * link-activation cases need real event dispatch, so they mount through
 * `createRoot` + `act` under the happy-dom preload, like radix-interaction.
 */

const SAMPLE = [
  "# Title",
  "",
  "Some **bold**, *italic*, `code`, and a [link](https://smithers.sh).",
  "",
  "- one",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "```",
  "const x = 1;",
  "```",
].join("\n");

describe("Markdown (static markup)", () => {
  test("is a memoized component (re-renders only on prop change)", () => {
    expect((Markdown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  test("renders headings, lists, code fence, inline styles, and links", () => {
    const html = renderToStaticMarkup(<Markdown content={SAMPLE} />);
    expect(html).toContain('data-slot="markdown"');
    expect(html).toContain("sui-md");
    // heading
    expect(html).toContain("sui-md-h1");
    expect(html).toContain("Title");
    // inline
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("sui-md-inline-code");
    expect(html).toContain(">code<");
    // link
    expect(html).toContain("sui-md-link");
    expect(html).toContain('href="https://smithers.sh"');
    // lists
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("sui-md-list");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>first</li>");
    // fenced code
    expect(html).toContain("sui-codeblock");
    expect(html).toContain("const x = 1;");
  });

  test("escapes raw HTML in the source (no markup injection)", () => {
    const html = renderToStaticMarkup(
      <Markdown content={'Hello <img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("drops non-navigable link schemes (javascript:)", () => {
    const html = renderToStaticMarkup(<Markdown content="[click](javascript:alert(1))" />);
    expect(html).not.toContain("javascript:");
    // label still renders as an anchor, just without a dangerous href.
    expect(html).toContain("sui-md-link");
    expect(html).toContain("click");
  });

  test("keeps a consumer className and data-slot", () => {
    const html = renderToStaticMarkup(<Markdown content="hi" className="mine" />);
    expect(html).toContain("mine");
    expect(html).toContain("sui-md");
    expect(html).toContain('data-slot="markdown"');
  });

  test("matches the uncached renderer across markdown block shapes", () => {
    const inputs = [
      "",
      "plain text",
      "first line\nsecond line",
      "first paragraph\n\nsecond paragraph",
      "# Heading\nparagraph\n## Next",
      "- one\n- two\nparagraph",
      "1. one\n2. two\n\n- three",
      "```\nconst x = 1;",
      "```ts\nconst x = 1;\n```\nAfter",
      "same\n\nsame\n\nlast",
      "Raw <tag> and **bold**, *italic*, `code`, and [link](/docs).",
      SAMPLE,
    ];

    for (const content of inputs) {
      const cached = renderToStaticMarkup(<Markdown content={content} />);
      const uncached = renderToStaticMarkup(
        <div data-slot="markdown" className="sui-md">
          {markdownBlockParser.render(content)}
        </div>,
      );
      expect(cached).toBe(uncached);
    }
  });
});

describe("Markdown (link activation)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let container: HTMLElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => r.unmount());
      root = undefined;
    }
    container?.remove();
    container = undefined;
    document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
  });

  async function render(element: ReactElement): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const r = root;
    await act(async () => r.render(element));
  }

  test("onLinkClick fires with the href and default navigation is prevented", async () => {
    const seen: string[] = [];
    await render(
      <Markdown content="Read the [docs](https://smithers.sh/docs) now." onLinkClick={(href) => seen.push(href)} />,
    );
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(seen).toEqual(["https://smithers.sh/docs"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("rejects unsafe links without invoking onLinkClick", async () => {
    const seen: string[] = [];
    await render(<Markdown content="Click [this](javascript:alert)" onLinkClick={(href) => seen.push(href)} />);
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    expect(anchor.hasAttribute("href")).toBe(false);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(seen).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("without onLinkClick the anchor keeps its href and default is not prevented", async () => {
    await render(<Markdown content="[docs](https://smithers.sh/docs)" />);
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://smithers.sh/docs");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  test("appending streamed content does not re-parse completed blocks", async () => {
    const parse = spyOn(markdownBlockParser, "render");
    try {
      await render(<Markdown content={"First.\n\nSecond"} />);
      expect(parse.mock.calls.filter(([source]) => source === "First.")).toHaveLength(1);

      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows"} />));
      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows\n\nThird"} />));
      const completedSecondParses = parse.mock.calls.filter(([source]) => source === "Second grows").length;
      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows\n\nThird grows"} />));

      expect(parse.mock.calls.filter(([source]) => source === "First.")).toHaveLength(1);
      expect(parse.mock.calls.filter(([source]) => source === "Second grows")).toHaveLength(completedSecondParses);
      expect(parse.mock.calls.filter(([source]) => source === "Third grows")).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});
