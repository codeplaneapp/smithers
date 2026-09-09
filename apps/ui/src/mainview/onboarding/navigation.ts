/*
 * The forward keyboard gesture is exactly the visible primary button.
 *
 * The plugin lessons (the Library, then the Librarian) are absent on purpose:
 * their primary button runs a REAL flow — `plugins`, then `plugins.install
 * librarian` — so GuideShell runs those directly and this table would only be
 * a second, quieter definition of the same gesture.
 */
export const guideForwardAction = (step: number): string =>
  ({
    1: "dark",
    6: "open",
    11: "revise",
    13: "accept-practice",
    14: "open",
  })[step] ?? "next"
