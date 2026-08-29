/// <reference path="../../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../../PACKAGE.js"
import { Package as src } from "../../src/PACKAGE.js"

const fixSentryIssue = S.Agent.Diff({
  prompt: S.file("SKILL.md"),
  payload: {
    issue: S.Input.Optional(
      S.Input.String("Sentry issue id, e.g. FORCE-PRODUCTION-XXXX"),
    ),
  },
  mcp: [S.Mcp.Http("sentry", "https://mcp.sentry.dev/mcp")],
  data: [src.srcs],
  changes: ["src/**"],
  gates: [src.typeCheck, src.test, src.lint],
  secrets: [S.Secret("GITHUB_TOKEN")],
  sandbox: { network: true },
  approval: "required",
  maxRounds: 3,
})

export const Package = S.Package({
  targets: { fixSentryIssue },
})
