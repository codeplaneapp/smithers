/** The forward keyboard gesture is exactly the visible primary button. */
export const guideForwardAction = (step: number): string =>
  ({
    5: "dark",
    6: "light",
    7: "open",
    8: "library",
    9: "librarian",
    12: "revise",
    15: "open",
  })[step] ?? "next"
