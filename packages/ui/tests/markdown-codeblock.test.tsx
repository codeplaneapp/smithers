import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/index";

describe("Markdown fenced CodeBlock routing", () => {
  test("routes fences through CodeBlock and parses the first info token as lowercase language", () => {
    const html = renderToStaticMarkup(
      <Markdown content={["```TypeScript title=example", "const x = 1;", "```"].join("\n")} />,
    );
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain("sui-codeblock");
    expect(html).toContain("sui-codeblock-lang");
    expect(html).toContain("typescript");
    expect(html).not.toContain("title=example");
    expect(html).toContain("const x = 1;");
  });

  test("an unterminated fence has exactly the terminated block structure", () => {
    const partial = renderToStaticMarkup(<Markdown content={["```ts", "const x = 1;"].join("\n")} />);
    const complete = renderToStaticMarkup(<Markdown content={["```ts", "const x = 1;", "```"].join("\n")} />);
    expect(partial).toBe(complete);
  });

  for (const [source, tag] of [
    ["Streaming **emphasis", "strong"],
    ["Streaming *emphasis", "em"],
    ["Streaming `code", "code"],
  ] as const) {
    test(`keeps incomplete ${tag} markdown literal`, () => {
      const html = renderToStaticMarkup(<Markdown content={source} />);
      expect(html).toContain(source);
      expect(html).not.toContain(`<${tag}>`);
    });
  }

});
