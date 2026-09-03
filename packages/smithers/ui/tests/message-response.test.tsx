import { describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse, SMITHERS_UI_STYLE_ATTR } from "../src/index";

describe("MessageResponse", () => {
  test("renders assistant markdown and a caret only while streaming", () => {
    const streaming = renderToStaticMarkup(
      <MessageResponse content="Hello **there**" streaming className="consumer" />,
    );
    expect(streaming).toContain('data-slot="message-response"');
    expect(streaming).toContain('data-streaming="true"');
    expect(streaming).toContain("sui-response consumer");
    expect(streaming).toContain("<strong>there</strong>");
    expect(streaming).toContain('data-slot="message-response-caret"');
    expect(streaming).toContain('aria-hidden="true"');

    const settled = renderToStaticMarkup(<MessageResponse content="Done" />);
    expect(settled).toContain('data-streaming="false"');
    expect(settled).not.toContain("message-response-caret");
  });

  test("keeps incomplete emphasis literal during streaming", () => {
    const html = renderToStaticMarkup(<MessageResponse content="Still **thinking" streaming />);
    expect(html).toContain("Still **thinking");
    expect(html).not.toContain("<strong>");
  });

  test("passes only sanitized hrefs through the response seam", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const seen: string[] = [];
    const render = async (element: ReactElement) => {
      await act(async () => root.render(element));
    };
    try {
      await render(
        <MessageResponse
          content="[safe](https://smithers.sh) [unsafe](javascript:alert)"
          onLinkClick={(href) => seen.push(href)}
        />,
      );
      const links = container.querySelectorAll("a");
      await act(async () => {
        links[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        links[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(seen).toEqual(["https://smithers.sh"]);
      expect(links[1]!.hasAttribute("href")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
    }
  });
});
