/** @jsxImportSource react */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  WebPreview,
  WebPreviewAddress,
  WebPreviewContent,
  WebPreviewToolbar,
} from "../src/sandbox/WebPreview";
import { SANDBOX_CSS_ID } from "../src/sandbox/sandboxCss";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
  document.querySelectorAll(`style[data-smithers-ui-lane="${SANDBOX_CSS_ID}"]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

async function typeAndEnter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

describe("WebPreview", () => {
  test("renders the default composition with an address bar and locked-down iframe", async () => {
    await render(<WebPreview url="https://example.com" />);
    const frame = container!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.com");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("title")).toBe("Web preview");
    expect(container!.querySelector('[data-slot="web-preview-toolbar"]')?.getAttribute("role")).toBe("toolbar");
    expect(container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')?.getAttribute("aria-label")).toBe("Preview address");
  });

  test("no url renders an honest empty state, never a fabricated preview", async () => {
    await render(<WebPreview />);
    expect(container!.querySelector("iframe")).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-content"]')?.textContent).toContain("No preview available");
  });

  test("address bar commits valid http(s) URLs via onUrlChange (controlled)", async () => {
    const commits: string[] = [];
    function Harness() {
      const [url, setUrl] = useState("https://example.com");
      return (
        <WebPreview
          url={url}
          onUrlChange={(next) => {
            commits.push(next);
            setUrl(next);
          }}
        />
      );
    }
    await render(<Harness />);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "https://other.dev/path");
    expect(commits).toEqual(["https://other.dev/path"]);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://other.dev/path");
    expect(container!.querySelector('[data-slot="web-preview-address-error"]')).toBeNull();
  });

  test("address bar rejects non-http(s) URLs inline without calling onUrlChange", async () => {
    const commits: string[] = [];
    await render(<WebPreview url="https://example.com" onUrlChange={(url) => commits.push(url)} />);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "javascript:alert(1)");
    expect(commits).toEqual([]);
    const error = container!.querySelector('[data-slot="web-preview-address-error"]')!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("http");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://example.com");
  });

  test("uncontrolled url seeds from defaultUrl and commits update the frame", async () => {
    await render(<WebPreview defaultUrl="https://a.dev" />);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://a.dev");
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "http://b.dev");
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("http://b.dev");
  });

  test("loading shows a skeleton overlay over the frame", async () => {
    await render(<WebPreview url="https://example.com" loading />);
    expect(container!.querySelector('[data-slot="web-preview-loading"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="web-preview"]')?.getAttribute("data-loading")).toBe("true");
  });

  test("toolbar nav buttons render only when their callbacks are provided", async () => {
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar onRefresh={() => {}}>
          <WebPreviewAddress />
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    expect(container!.querySelector('[data-slot="web-preview-back"]')).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-forward"]')).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-refresh"]')).not.toBeNull();
  });

  test("toolbar buttons fire callbacks and rove tabindex with arrow keys", async () => {
    let backs = 0;
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar
          onBack={() => {
            backs += 1;
          }}
          onForward={() => {}}
        >
          <WebPreviewAddress />
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    const back = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-back"]')!;
    await act(async () => back.click());
    expect(backs).toBe(1);
    expect(back.tabIndex).toBe(0);
    const forward = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-forward"]')!;
    expect(forward.tabIndex).toBe(-1);

    await act(async () => {
      back.focus();
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(forward);
    expect(forward.tabIndex).toBe(0);
    expect(back.tabIndex).toBe(-1);
  });

  test("WebPreviewContent drops allow-same-origin when combined with allow-scripts and warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await render(
        <WebPreviewContent src="https://example.com" sandboxAllow={["allow-scripts", "allow-same-origin", "allow-forms"]} />,
      );
      const frame = container!.querySelector("iframe")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("WebPreviewContent keeps allow-same-origin when scripts are not allowed", async () => {
    await render(<WebPreviewContent src="https://example.com" sandboxAllow={["allow-same-origin", "allow-forms"]} />);
    expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin allow-forms");
  });

  test("sandbox attribute is always rendered, even with an empty token list", async () => {
    await render(<WebPreviewContent src="https://example.com" sandboxAllow={[]} />);
    expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });

  test("renders under the dark theme with the lane stylesheet injected", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<WebPreview url="https://example.com" />);
    expect(container!.querySelector('[data-slot="web-preview"]')).not.toBeNull();
    expect(document.querySelector(`style[data-smithers-ui-lane="${SANDBOX_CSS_ID}"]`)).not.toBeNull();
  });
});
