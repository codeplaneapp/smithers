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
  test("an element whose type is an uncompiled .mdx path reports MDX_PRELOAD_INACTIVE", () => {
    // With the preload inactive, Bun's file loader makes the default export of
    // `./prompt.mdx` the module path, so `<MyPrompt />` is a VALID element whose
    // type is that path and React throws "Invalid tag: ...". That React error is
    // useless on its own; the preload diagnosis has to survive.
    let caught;
    try {
      renderPromptToText(React.createElement("/abs/workflows/prompt.mdx", { x: 1 }));
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("MDX_PRELOAD_INACTIVE");
    expect(caught.message).toContain("/abs/workflows/prompt.mdx");
    expect(caught.message).toContain("bunfig.toml");
  });
  test("an element whose type is a module namespace object reports MDX_PRELOAD_INACTIVE", () => {
    let caught;
    try {
      renderPromptToText(React.createElement(/** @type {any} */ ({ frontmatter: {} })));
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("MDX_PRELOAD_INACTIVE");
  });
  test("a real host element that throws is not misread as an uncompiled MDX import", () => {
    function Broken() {
      throw new Error("host child bug");
    }
    let caught;
    try {
      renderPromptToText(React.createElement("div", null, React.createElement(Broken)));
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).not.toBe("MDX_PRELOAD_INACTIVE");
    expect(caught.message).toContain("host child bug");
  });
  test("the cycle fallback honors an array replacer and visits each object once", () => {
    const shared = { id: "shared" };
    function PropsDump() {
      const root = { a: shared, b: shared, drop: "no" };
      root.self = root;
      return <>{JSON.stringify(root, ["a", "b", "id", "self"])}</>;
    }
    const result = renderPromptToText(React.createElement(PropsDump));
    // The array replacer is a property allowlist and still filters `drop`.
    expect(result).not.toContain("drop");
    // Visit-once: the cycle AND the second reference to `shared` collapse. That
    // bounds a shared React element DAG, which would otherwise exhaust memory.
    expect(result).toBe('{"a":{"id":"shared"},"b":"[Circular]","self":"[Circular]"}');
  });
});
