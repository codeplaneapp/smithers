import { Smithers as S } from "@smthrs/targets"

// Keep confinement required and let the host select its native mechanism:
// bubblewrap on Linux and seatbelt on macOS.
export const sandboxes = S.Sandboxes({})
