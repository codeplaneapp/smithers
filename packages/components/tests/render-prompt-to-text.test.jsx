import { describe, expect, test } from "bun:test";
import React from "react";
import { renderPromptToText } from "../src/components/taskCore.js";
/**
 * MDX-like component: reads its tag mapping off the standard MDX
 * `components` prop, exactly like a compiled .mdx file does.
 * @param {{ components?: Record<string, any> }} value
 */
function SimpleMdx({ components }) {
  const H1 = components?.h1 ?? "h1";
  const P = components?.p ?? "p";
  return (
    <>
      <H1>Hello World</H1>
      <P>This is a paragraph.</P>
    </>
  );
}
describe("renderPromptToText", () => {
  test("injects markdownComponents into a prompt element", () => {
    const result = renderPromptToText(React.createElement(SimpleMdx));
    expect(result).toContain("# Hello World");
    expect(result).toContain("This is a paragraph.");
  });
  test("merges user-supplied MDX components instead of overwriting them", () => {
    const custom = {
      p: ({ children }) => React.createElement(React.Fragment, null, "CUSTOM: ", children),
    };
    const result = renderPromptToText(React.createElement(SimpleMdx, { components: custom }));
    expect(result).toContain("CUSTOM: This is a paragraph.");
    // Non-overridden tags still use the markdown mapping.
    expect(result).toContain("# Hello World");
  });
  test("markdownComponents win when the user supplies none", () => {
    const result = renderPromptToText(React.createElement(SimpleMdx, { components: undefined }));
    expect(result).toContain("# Hello World");
  });
});
