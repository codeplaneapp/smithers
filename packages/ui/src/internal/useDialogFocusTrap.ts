import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeDialogStack: HTMLElement[] = [];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    return element.tabIndex >= 0;
  });
}

function removeDialogFromStack(container: HTMLElement) {
  const index = activeDialogStack.lastIndexOf(container);
  if (index >= 0) activeDialogStack.splice(index, 1);
}

export type UseDialogFocusTrapOptions = {
  /** Set false to suspend the trap without unmounting the dialog. */
  active?: boolean;
  /** The dialog container; give it `tabIndex={-1}` so it can take focus when empty. */
  containerRef: RefObject<HTMLElement | null>;
  /** Focused on open; defaults to the first focusable element in the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Called when Escape is pressed while this dialog is top-most. */
  onClose: () => void;
};

/**
 * Trap focus inside the top-most dialog, close on Escape, and restore the
 * element that opened it. Stacked modals are supported: only the last mounted
 * (or re-activated) dialog responds to keyboard and focus events.
 */
export function useDialogFocusTrap({
  active = true,
  containerRef,
  initialFocusRef,
  onClose,
}: UseDialogFocusTrapOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeDialogStack.push(container);

    const isTopDialog = () => activeDialogStack.at(-1) === container;
    const focusInitial = () => {
      const target = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
      target.focus();
    };

    window.requestAnimationFrame(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (!container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialog()) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && container.contains(target)) return;
      focusInitial();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      removeDialogFromStack(container);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}
