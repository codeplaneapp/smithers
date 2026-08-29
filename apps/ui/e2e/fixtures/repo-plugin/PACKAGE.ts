import { Smithers as S } from "@smthrs/targets"

const hello = S.Shell.Test({
  bun: "console.log('plugin-hello')",
})

export const Package = S.Package({
  targets: { hello },
})
