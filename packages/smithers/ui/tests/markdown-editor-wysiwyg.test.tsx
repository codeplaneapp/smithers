/** @jsxImportSource react */
// The WYSIWYG half of the markdown-editor adapter.
//
// happy-dom computes no layout, so `supportsRichTextEditing()` is false here
// and the component would otherwise always render its textarea. These tests
// drive the real path by supplying `fallback={false}` plus a stub
// `loadEditor`, which is the seam that replaced the old user-agent sniff:
// listener wiring, echo suppression, readonly, reseed, teardown and the
// failure path are all reachable without the ProseMirror runtime.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MARKDOWN_EDITOR_STYLE_ATTR,
  MarkdownEditor,
  type MarkdownEditorError,
  type MarkdownEditorHandle,
  type MarkdownEditorModule,
  supportsRichTextEditing,
} from "../src/adapters/markdown-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

async function rerender(element: ReactElement): Promise<void> {
  const mounted = root;
  if (!mounted) throw new Error("nothing rendered yet");
  await act(async () => mounted.render(element));
}

function host(): HTMLElement {
  const el = container?.querySelector<HTMLElement>('[data-testid="markdown-editor"]');
  if (!el) throw new Error("markdown editor not found");
  return el;
}

/** A recording stand-in for the pieces of Crepe this adapter drives. */
function stubEditor() {
  const created: string[] = [];
  const destroyed: string[] = [];
  const readonlyCalls: boolean[] = [];
  const replaced: string[] = [];
  let emit: ((markdown: string) => void) | undefined;

  const module: MarkdownEditorModule = {
    Crepe: class {
      readonly editor = {
        action: (command: unknown) => {
          // `replaceAll` returns a tagged command; running it re-emits the
          // document exactly as Milkdown does, which is the echo under test.
          const markdown = (command as { markdown: string }).markdown;
          replaced.push(markdown);
          emit?.(markdown);
          return undefined;
        },
      };
      constructor(readonly options: { root: HTMLElement; defaultValue: string }) {
        created.push(options.defaultValue);
      }
      on(configure: (listener: { markdownUpdated: (handler: (ctx: unknown, md: string) => void) => void }) => void) {
        configure({
          markdownUpdated: (handler) => {
            emit = (markdown) => handler(undefined, markdown);
          },
        });
      }
      async create() {
        this.options.root.append(document.createElement("div"));
      }
      async destroy() {
        destroyed.push(this.options.defaultValue);
      }
      setReadonly(readOnly: boolean) {
        readonlyCalls.push(readOnly);
      }
    } as unknown as MarkdownEditorModule["Crepe"],
    replaceAll: (markdown: string) => ({ markdown }),
  };

  return {
    module,
    created,
    destroyed,
    readonlyCalls,
    replaced,
    load: async () => module,
    typeInEditor: (markdown: string) => emit?.(markdown),
  };
}

describe("supportsRichTextEditing", () => {
  test("reports false where the document computes no layout", () => {
    // happy-dom measures every element as 0x0. A real browser reports the
    // probe's 20x20, which is exactly the capability ProseMirror needs.
    expect(supportsRichTextEditing()).toBe(false);
  });
});

describe("MarkdownEditor (WYSIWYG path)", () => {
  test("mounts the real editor, seeded with the current markdown", async () => {
    const stub = stubEditor();
    await render(<MarkdownEditor value="# seed" fallback={false} loadEditor={stub.load} />);

    expect(host().getAttribute("data-mode")).toBe("wysiwyg");
    expect(stub.created).toEqual(["# seed"]);
    expect(stub.readonlyCalls).toEqual([false]);
  });

  test("a local edit inside the editor reaches onChange and getMarkdown", async () => {
    const stub = stubEditor();
    const changes: string[] = [];
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value="start"
        fallback={false}
        loadEditor={stub.load}
        onChange={(markdown) => changes.push(markdown)}
      />,
    );

    await act(async () => stub.typeInEditor("start and more"));
    expect(changes).toEqual(["start and more"]);
    expect((handle as unknown as MarkdownEditorHandle).getMarkdown()).toBe("start and more");
  });

  test("setMarkdown replaces the document and suppresses the resulting echo", async () => {
    const stub = stubEditor();
    const changes: string[] = [];
    let handle: MarkdownEditorHandle | null = null;
    await render(
      <MarkdownEditor
        ref={(h) => {
          handle = h;
        }}
        value="one"
        fallback={false}
        loadEditor={stub.load}
        onChange={(markdown) => changes.push(markdown)}
      />,
    );

    const api = handle as unknown as MarkdownEditorHandle;
    await act(async () => api.setMarkdown("two"));
    expect(stub.replaced).toEqual(["two"]);
    expect(api.getMarkdown()).toBe("two");
    // The replaceAll echo must NOT loop back out as a local edit.
    expect(changes).toEqual([]);

    // A genuine edit after the echo window still reports.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stub.typeInEditor("three");
    });
    expect(changes).toEqual(["three"]);
  });

  test("readOnly is applied to the editor and re-applied when it changes", async () => {
    const stub = stubEditor();
    const view = (readOnly: boolean): ReactElement => (
      <MarkdownEditor value="frozen" readOnly={readOnly} fallback={false} loadEditor={stub.load} />
    );
    await render(view(true));
    expect(stub.readonlyCalls).toEqual([true]);

    await rerender(view(false));
    expect(stub.readonlyCalls).toEqual([true, false]);
    // Toggling editability rebuilds the editor, and the old one is torn down.
    expect(stub.destroyed.length).toBe(1);
  });

  test("resetKey rebuilds the editor seeded with the new value", async () => {
    const stub = stubEditor();
    const view = (value: string, resetKey: number): ReactElement => (
      <MarkdownEditor value={value} resetKey={resetKey} fallback={false} loadEditor={stub.load} />
    );
    await render(view("alpha", 0));
    expect(stub.created).toEqual(["alpha"]);

    // Same key, new value: live edits are never clobbered.
    await rerender(view("beta", 0));
    expect(stub.created).toEqual(["alpha"]);

    await rerender(view("gamma", 1));
    expect(stub.created).toEqual(["alpha", "gamma"]);
  });

  test("unmounting destroys the editor", async () => {
    const stub = stubEditor();
    await render(<MarkdownEditor value="bye" fallback={false} loadEditor={stub.load} />);
    const mounted = root!;
    root = undefined;
    await act(async () => mounted.unmount());
    expect(stub.destroyed).toEqual(["bye"]);
  });
});

describe("MarkdownEditor failure reporting", () => {
  test("a rejecting loader falls back to the seeded textarea and reports the cause", async () => {
    const cause = new Error("chunk 404");
    const errors: MarkdownEditorError[] = [];
    await render(
      <MarkdownEditor
        value="# still editable"
        fallback={false}
        loadEditor={async () => {
          throw cause;
        }}
        onError={(error) => errors.push(error)}
      />,
    );

    const el = host();
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.getAttribute("data-mode")).toBe("failed");
    expect((el as HTMLTextAreaElement).value).toBe("# still editable");
    expect(errors).toEqual([{ code: "editor-load-failed", cause }]);
  });

  test("an editor that loads but cannot start reports editor-create-failed", async () => {
    const cause = new Error("no view");
    const errors: MarkdownEditorError[] = [];
    const module: MarkdownEditorModule = {
      Crepe: class {
        readonly editor = { action: () => undefined };
        constructor(readonly options: { root: HTMLElement; defaultValue: string }) {}
        on() {}
        async create() {
          throw cause;
        }
        async destroy() {}
        setReadonly() {}
      } as unknown as MarkdownEditorModule["Crepe"],
      replaceAll: (markdown: string) => ({ markdown }),
    };

    await render(
      <MarkdownEditor
        value="seed"
        fallback={false}
        loadEditor={async () => module}
        onError={(error) => errors.push(error)}
      />,
    );

    expect(host().getAttribute("data-mode")).toBe("failed");
    expect(errors).toEqual([{ code: "editor-create-failed", cause }]);
  });

  test("a new resetKey retries after a failure", async () => {
    const cause = new Error("chunk 404");
    const stub = stubEditor();
    let failNext = true;
    const view = (resetKey: number): ReactElement => (
      <MarkdownEditor
        value={`document ${resetKey}`}
        resetKey={resetKey}
        fallback={false}
        loadEditor={async () => {
          if (failNext) throw cause;
          return stub.module;
        }}
      />
    );

    await render(view(0));
    expect(host().getAttribute("data-mode")).toBe("failed");

    failNext = false;
    await rerender(view(1));
    expect(host().getAttribute("data-mode")).toBe("wysiwyg");
    expect(stub.created).toEqual(["document 1"]);
  });
});
