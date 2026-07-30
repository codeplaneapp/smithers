import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "../src/markdownComponents.js";
/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {any[]} ...children
 */
function render(tag, props = {}, ...children) {
  const Component = markdownComponents[tag];
  if (!Component) throw new Error(`No component for tag: ${tag}`);
  return renderToStaticMarkup(React.createElement(Component, props, ...children));
}
describe("markdownComponents", () => {
  describe("headings", () => {
    test("h1 renders with # prefix", () => {
      expect(render("h1", {}, "Title")).toBe("# Title\n\n");
    });
    test("h2 renders with ## prefix", () => {
      expect(render("h2", {}, "Subtitle")).toBe("## Subtitle\n\n");
    });
    test("h3 renders with ### prefix", () => {
      expect(render("h3", {}, "Section")).toBe("### Section\n\n");
    });
    test("h4 renders with #### prefix", () => {
      expect(render("h4", {}, "Subsection")).toBe("#### Subsection\n\n");
    });
    test("h5 renders with ##### prefix", () => {
      expect(render("h5", {}, "Minor")).toBe("##### Minor\n\n");
    });
    test("h6 renders with ###### prefix", () => {
      expect(render("h6", {}, "Tiny")).toBe("###### Tiny\n\n");
    });
  });
  describe("block elements", () => {
    test("p renders with trailing newlines", () => {
      expect(render("p", {}, "Hello world")).toBe("Hello world\n\n");
    });
    test("blockquote renders with > prefix", () => {
      // React's renderToStaticMarkup HTML-escapes the > character
      expect(render("blockquote", {}, "Quote")).toBe("&gt; Quote\n");
    });
    test("hr renders as ---", () => {
      expect(render("hr")).toBe("---\n\n");
    });
  });
  describe("lists", () => {
    test("li renders with - prefix", () => {
      expect(render("li", {}, "Item")).toBe("- Item\n");
    });
    test("ul wraps children with newline", () => {
      expect(render("ul", {}, "content")).toBe("content\n");
    });
    test("ol wraps children with newline", () => {
      expect(render("ol", {}, "content")).toBe("content\n");
    });
    test("ol numbers its items instead of bulleting them", () => {
      const Li = markdownComponents.li;
      const result = render("ol", {}, React.createElement(Li, null, "First"), React.createElement(Li, null, "Second"));
      expect(result).toBe("1. First\n2. Second\n\n");
    });
    test("ol counts from the start attribute", () => {
      const Li = markdownComponents.li;
      const result = render(
        "ol",
        { start: 3 },
        React.createElement(Li, null, "Third"),
        React.createElement(Li, null, "Fourth"),
      );
      expect(result).toBe("3. Third\n4. Fourth\n\n");
    });
    test("ol numbers past the whitespace nodes MDX emits between items", () => {
      const Li = markdownComponents.li;
      const result = render(
        "ol",
        {},
        "\n",
        React.createElement(Li, null, "First"),
        "\n",
        React.createElement(Li, null, "Second"),
        "\n",
      );
      expect(result).toBe("\n1. First\n\n2. Second\n\n\n");
    });
    test("ul leaves its items as bullets", () => {
      const Li = markdownComponents.li;
      const result = render("ul", {}, React.createElement(Li, null, "Item"));
      expect(result).toBe("- Item\n\n");
    });
  });
  describe("code", () => {
    test("inline code renders with backticks", () => {
      expect(render("code", {}, "x + 1")).toBe("`x + 1`");
    });
    test("code with className renders as fenced block", () => {
      const result = render("code", { className: "language-typescript" }, "const x = 1;");
      expect(result).toBe("```typescript\nconst x = 1;\n```\n\n");
    });
    test("code extracts the language token from a multi-class className", () => {
      expect(render("code", { className: "highlight language-js" }, "x")).toBe("```js\nx\n```\n\n");
      expect(render("code", { className: "language-js linenos" }, "x")).toBe("```js\nx\n```\n\n");
      expect(render("code", { className: "highlight language-ts linenos" }, "x")).toBe("```ts\nx\n```\n\n");
    });
    test("code with a className but no language token renders inline", () => {
      expect(render("code", { className: "highlight" }, "x")).toBe("`x`");
    });
    test("pre passes through children", () => {
      expect(render("pre", {}, "raw")).toBe("raw");
    });
  });
  describe("inline formatting", () => {
    test("strong renders with **", () => {
      expect(render("strong", {}, "bold")).toBe("**bold**");
    });
    test("em renders with *", () => {
      expect(render("em", {}, "italic")).toBe("*italic*");
    });
    test("a renders as markdown link", () => {
      expect(render("a", { href: "https://example.com" }, "click")).toBe("[click](https://example.com)");
    });
    test("br renders newline", () => {
      expect(render("br")).toBe("\n");
    });
  });
  describe("images", () => {
    test("img renders as markdown image", () => {
      expect(render("img", { alt: "logo", src: "logo.png" })).toBe("![logo](logo.png)");
    });
    test("img with no alt uses empty string", () => {
      expect(render("img", { src: "pic.png" })).toBe("![](pic.png)");
    });
  });
  describe("tables", () => {
    test("table renders children with trailing newline", () => {
      expect(render("table", {}, "rows")).toBe("rows\n");
    });
    test("thead passes through children exactly", () => {
      expect(render("thead", {}, "| Header |\n")).toBe("| Header |\n");
    });
    test("tbody passes through children exactly", () => {
      expect(render("tbody", {}, "| Data |\n")).toBe("| Data |\n");
    });
    test("tr renders with pipe separators", () => {
      expect(render("tr", {}, "cells")).toBe("| cells\n");
    });
    test("th renders with trailing pipe", () => {
      expect(render("th", {}, "Header")).toBe("Header | ");
    });
    test("td renders with trailing pipe", () => {
      expect(render("td", {}, "Data")).toBe("Data | ");
    });
  });
  describe("pass-through containers", () => {
    test("div passes through with newline", () => {
      expect(render("div", {}, "content")).toBe("content\n");
    });
    test("section passes through with newline", () => {
      expect(render("section", {}, "content")).toBe("content\n");
    });
    test("span passes through without newline", () => {
      expect(render("span", {}, "inline")).toBe("inline");
    });
  });
});
