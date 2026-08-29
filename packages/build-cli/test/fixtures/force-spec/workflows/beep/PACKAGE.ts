/// <reference path="../../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const beep = S.Shell.Run({
  command: "afplay /System/Library/Sounds/Glass.aiff",
  sandbox: "none",
})

export const Package = S.Package({
  targets: { beep },
})
