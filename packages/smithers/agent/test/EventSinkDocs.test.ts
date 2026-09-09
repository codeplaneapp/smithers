import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["../src/EventSink.ts", "../docs/guides/model-backed-steps.md", "../docs/api.md"])(
  "%s states the durable model-call delivery boundary",
  (path) => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s*\*?\s+/g, " ")
    expect(text).toContain("sealed model-call boundary")
    expect(text).toContain("after the provider stream settles")
    expect(text).toContain("replay")
  }
)
