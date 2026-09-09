/** The forward keyboard gesture is exactly the visible primary button. */
export const guideForwardAction = (step: number): string =>
  ({
    1: "dark",
    2: "light",
    7: "open",
    8: "library",
    9: "librarian",
    12: "revise",
    14: "accept-practice",
    15: "open",
  })[step] ?? "next"
