import { useUiStore } from "../app/uiStore";

/**
 * A full-viewport click-catcher rendered behind an open menu. Replaces the
 * document pointerdown listener every dropdown used to register in an effect:
 * pointer-down anywhere outside the menu lands here and closes it. Rendered as a
 * sibling just before the menu, so the menu's higher z-index keeps it on top.
 */
export function MenuBackdrop() {
  const setOpenMenu = useUiStore((state) => state.setOpenMenu);
  return (
    <div
      aria-hidden="true"
      className="menu-backdrop"
      onPointerDown={() => setOpenMenu(null)}
    />
  );
}
