import {
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { goToView, openSurface } from "./app/navigation";
import { useRouteStore } from "./app/routeStore";
import { useUiStore } from "./app/uiStore";
import { COMMANDS, type CommandId } from "./commands";
import { NAV_LINKS } from "./navMenu";
import { MenuBackdrop } from "./components/MenuBackdrop";

const ChevronDown = () => (
  <svg aria-hidden="true" className="chevron" fill="none" viewBox="0 0 24 24">
    <path
      d="m6 9 6 6 6-6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

const ChevronRight = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
    <path
      d="m9 6 6 6-6 6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

const Magnifier = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
  </svg>
);

const Check = () => (
  <svg aria-hidden="true" className="check" fill="none" viewBox="0 0 24 24">
    <path
      d="m5 13 4 4L19 7"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

/** Focus the checked item on open, else the first (APG menu pattern). */
function focusChecked(menu: HTMLDivElement | null): void {
  if (!menu) {
    return;
  }
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  );
  const checked = items.find((item) => item.getAttribute("aria-checked") === "true");
  (checked ?? items[0])?.focus();
}

/**
 * A colored dropdown pill that selects the active mode and navigates the app. The
 * menu has three groups: the three modes as a radio set (Chat / Ask Me / Store),
 * a "Go to" list that opens each canvas surface, and a Find row that opens the
 * command palette.
 */
export function CommandMenu() {
  const view = useRouteStore((state) => state.view);
  const open = useUiStore((state) => state.openMenuId === "command");
  const toggleMenu = useUiStore((state) => state.toggleMenu);
  const setOpenMenu = useUiStore((state) => state.setOpenMenu);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active: CommandId = view === "store" ? view : "chat";
  const current = COMMANDS.find((command) => command.id === active) ?? COMMANDS[0];

  const close = (): void => {
    setOpenMenu(null);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      close();
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    );
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[nextIndex].focus();
  };

  return (
    <div className="command-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="command-pill"
        ref={triggerRef}
        style={{ "--cmd-color": current.color } as CSSProperties}
        type="button"
        onClick={() => toggleMenu("command")}
      >
        <span className="command-dot" />
        <span>{current.label}</span>
        <ChevronDown />
      </button>

      {open ? (
        <>
          <MenuBackdrop />
          <div
            className="command-list"
            ref={focusChecked}
            role="menu"
            onKeyDown={onMenuKeyDown}
          >
            <div className="command-group" role="group" aria-label="Mode">
              <div className="command-section" aria-hidden="true">
                Mode
              </div>
              {COMMANDS.map((command) => (
                <button
                  aria-checked={command.id === active}
                  className="command-option"
                  key={command.id}
                  role="menuitemradio"
                  style={{ "--cmd-color": command.color } as CSSProperties}
                  type="button"
                  onClick={() => {
                    goToView(command.id === "chat" ? "home" : command.id);
                    close();
                  }}
                >
                  <span className="command-dot" />
                  <span className="command-text">
                    <span className="command-label">{command.label}</span>
                    <span className="command-hint">{command.hint}</span>
                  </span>
                  {command.id === active ? <Check /> : null}
                </button>
              ))}
            </div>

            <div className="command-divider" role="separator" />

            <div className="command-group" role="group" aria-label="Go to">
              <div className="command-section" aria-hidden="true">
                Go to
              </div>
              {NAV_LINKS.map((link) => (
                <button
                  className="command-option"
                  key={link.id}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    openSurface(link.surface);
                    close();
                  }}
                >
                  <span className="command-go-icon">
                    <ChevronRight />
                  </span>
                  <span className="command-label">{link.label}</span>
                </button>
              ))}
            </div>

            <div className="command-divider" role="separator" />

            <button
              className="command-option"
              role="menuitem"
              type="button"
              onClick={() => {
                openSurface({ kind: "palette" });
                close();
              }}
            >
              <span className="command-go-icon">
                <Magnifier />
              </span>
              <span className="command-label">Find…</span>
              <span className="command-shortcut">⌘K</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
