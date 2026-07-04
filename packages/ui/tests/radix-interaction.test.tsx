// Radix behavior under happy-dom: real createRoot + act, the gateway-react
// convention. happy-dom has no layout engine, so these tests assert
// open/close/aria state only -- never floating-ui placement.
//
// The DOM comes from tests/happy-dom-preload.ts (bunfig `[test] preload`):
// Radix decides whether layout effects run by checking `globalThis.document`
// at module-load time, so registering happy-dom here (after hoisted imports)
// would be too late and portals would render nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  SMITHERS_UI_STYLE_ATTR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../src/index";

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

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Radix Tabs activates on mousedown; happy-dom's .click() emits only `click`. */
async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    (el as HTMLElement).click();
  });
}

describe("style auto-injection", () => {
  test("mounting any component injects the sheet exactly once", async () => {
    await render(
      <div>
        <Button>a</Button>
        <Button>b</Button>
      </div>,
    );
    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain(".sui-button");
  });
});

describe("Dialog", () => {
  function harness() {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open ticket</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ticket 42</DialogTitle>
            <DialogDescription>Full details</DialogDescription>
          </DialogHeader>
          <p>body text</p>
        </DialogContent>
      </Dialog>
    );
  }

  test("opens through the trigger, portals to body, closes on Escape", async () => {
    await render(harness());
    expect(document.querySelector(".sui-dialog-content")).toBeNull();

    const trigger = document.querySelector('[data-slot="dialog-trigger"]');
    expect(trigger).not.toBeNull();
    await click(trigger!);

    const content = document.querySelector(".sui-dialog-content");
    expect(content).not.toBeNull();
    expect(content!.getAttribute("role")).toBe("dialog");
    expect(content!.getAttribute("data-state")).toBe("open");
    expect(document.body.textContent).toContain("Ticket 42");
    expect(document.querySelector(".sui-dialog-overlay")).not.toBeNull();
    // Portaled content escapes the render container -- styling must be
    // document-global, which the injected sheet is.
    expect(container!.contains(content)).toBe(false);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".sui-dialog-content")).toBeNull();
  });

  test("closes through the built-in close button", async () => {
    await render(harness());
    await click(document.querySelector('[data-slot="dialog-trigger"]')!);
    expect(document.querySelector(".sui-dialog-content")).not.toBeNull();

    await click(document.querySelector(".sui-dialog-close")!);
    expect(document.querySelector(".sui-dialog-content")).toBeNull();
  });
});

describe("Tabs", () => {
  test("switches content and active state on click", async () => {
    await render(
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs" count={2}>
            Runs
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">run list</TabsContent>
        <TabsContent value="events">event list</TabsContent>
      </Tabs>,
    );

    const triggers = Array.from(document.querySelectorAll(".sui-tabs-trigger"));
    expect(triggers.length).toBe(2);
    expect(triggers[0]!.getAttribute("data-state")).toBe("active");
    expect(document.body.textContent).toContain("run list");
    expect(document.body.textContent).not.toContain("event list");

    await press(triggers[1]!);
    expect(triggers[1]!.getAttribute("data-state")).toBe("active");
    expect(triggers[0]!.getAttribute("data-state")).toBe("inactive");
    expect(document.body.textContent).toContain("event list");
    expect(document.body.textContent).not.toContain("run list");
  });
});
