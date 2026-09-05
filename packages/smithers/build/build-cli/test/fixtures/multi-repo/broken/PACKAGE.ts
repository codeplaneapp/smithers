import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: { test: S.Shell.Test({ shell: "echo should-not-run" }) }
})
