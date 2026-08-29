import { Smithers as S } from "@smthrs/targets"

const polish = S.Shell.Test({
  bun: "console.log('plugin-polish')",
})

export const Package = S.Package({
  targets: { polish },
})
