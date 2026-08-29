/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

const playwrightConfig = S.file("//playwright.config.ts")

const e2e = S.Filegroup({
  srcs: S.glob(["e2e/**"]),
})

const smoke = S.Shell.Test({
  bin: S.NodeModule.Bin("@playwright/test"),
  args: ["test"],
  data: [e2e, playwrightConfig],
  services: [src.dev],
})

export const Package = S.Package({
  targets: { e2e, smoke },
})
