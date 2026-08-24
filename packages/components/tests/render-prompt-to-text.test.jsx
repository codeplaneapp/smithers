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
  test("a prompt that stringifies cyclic props renders [Circular] instead of throwing", () => {
    // React dev builds make element graphs cyclic (`_owner` chains back into
    // fibers/debug tasks), and MDX layout semantics inject such an element as
    // `props.children`. A prompt that dumps its props must still render.
    function PropsDump(props) {
      const cyclic = { name: "self" };
      cyclic.self = cyclic;
      return <>{JSON.stringify({ ...props, cyclic }, null, 2)}</>;
    }
    const result = renderPromptToText(React.createElement(PropsDump, { alert: "a-1" }));
    expect(result).toContain('"alert": "a-1"');
    expect(result).toContain("[Circular]");
    // The global stringify is restored after the render.
    expect(() => JSON.stringify({ a: { b: 1 } })).not.toThrow();
  });
  test("a valid element that throws surfaces the component error, not MDX_PRELOAD_INACTIVE", () => {
    function Broken() {
      throw new Error("user prompt bug");
    }
    let caught;
    try {
      renderPromptToText(React.createElement(Broken));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain("user prompt bug");
    expect(caught.code).not.toBe("MDX_PRELOAD_INACTIVE");
  });
  test("a plain object prompt still reports MDX_PRELOAD_INACTIVE", () => {
    let caught;
    try {
      renderPromptToText({ kind: "uncompiled-mdx-module" });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("MDX_PRELOAD_INACTIVE");
  });
});
