/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

export const sandboxes = S.Sandboxes({
  default: S.Sandbox.Bubblewrap(),
  docker: S.Sandbox.Docker({ image: "node:22" }),
})
