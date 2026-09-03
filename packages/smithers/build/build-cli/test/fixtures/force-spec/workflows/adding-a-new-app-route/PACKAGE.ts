/// <reference path="../../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../../PACKAGE.js"
import { Package as src } from "../../src/PACKAGE.js"

const templates = S.Filegroup({
  srcs: S.glob(["templates/**"]),
})

const addAppRoute = S.Agent.Diff({
  prompt: S.file("SKILL.md"),
  payload: {
    name: S.Input.String("App name, e.g. MyApp"),
    route: S.Input.String("Route path, e.g. /my-app"),
    kind: S.Input.Literals(["static", "dynamic"]),
  },
  data: [src.srcs, templates],
  changes: ["src/Apps/**", "src/appRoutes.gen.ts"],
  gates: [src.typeCheck, src.lint, src.routesGen],
  maxRounds: 3,
})

export const Package = S.Package({
  targets: { addAppRoute },
})
