import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: { test: S.Shell.Test({ command: "echo should-not-run" }) }
})
