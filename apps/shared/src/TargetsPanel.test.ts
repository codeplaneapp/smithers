import { describe, expect, test } from "bun:test"
import type { Target } from "./LocalApp"
import {
  buildTargetsInstructions,
  defaultTargetsMessage,
  groupTargets,
  parseTargetsInstructions,
  parseTargetsPanelReply,
  renderTargetsPanel,
  TARGETS_PANEL_MARKER
} from "./TargetsPanel"

const targets: ReadonlyArray<Target> = [
  { label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint" },
  { label: "//src:test", target: "Shell.Test", kinds: ["test"], package: "//src", name: "test" },
  { label: "//:detectSecrets", target: "Shell.Test", kinds: ["test"], package: "//", name: "detectSecrets" }
]

describe("the targets-panel instruction", () => {
  test("carries the marker, the repository and the target JSON, and parses back", () => {
    const instructions = buildTargetsInstructions({ repoName: "artsy/force", repoPath: "/Users/u/force", targets })
    expect(instructions.startsWith(TARGETS_PANEL_MARKER)).toBe(true)
    expect(instructions).toContain("{\"message\": string, \"html\": string}")
    expect(instructions).toContain("smithers: \"run\"")
    expect(parseTargetsInstructions(instructions)).toEqual({ repoName: "artsy/force", targets: [...targets] })
  })

  test("an instruction without the marker or the list parses to nothing or an empty list", () => {
    expect(parseTargetsInstructions("plain chat")).toBeUndefined()
    expect(parseTargetsInstructions(`Answer as JSON. ${TARGETS_PANEL_MARKER}`)).toEqual({ repoName: "", targets: [] })
  })
})

describe("the panel reply", () => {
  test("accepts bare JSON, fenced JSON, and JSON inside prose", () => {
    const reply = { message: "Loaded.", html: "<div>x</div>" }
    expect(parseTargetsPanelReply(JSON.stringify(reply))).toEqual(reply)
    expect(parseTargetsPanelReply(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``)).toEqual(reply)
    expect(parseTargetsPanelReply(`Here you go:\n${JSON.stringify(reply)}\nEnjoy.`)).toEqual(reply)
    expect(parseTargetsPanelReply(JSON.stringify({ html: "<p>only</p>" }))).toEqual({ message: "", html: "<p>only</p>" })
  })

  test("refuses invalid JSON and an empty html", () => {
    expect(parseTargetsPanelReply("not json at all")).toBeUndefined()
    expect(parseTargetsPanelReply("{\"message\": \"x\"}")).toBeUndefined()
    expect(parseTargetsPanelReply("{\"message\": \"x\", \"html\": \"  \"}")).toBeUndefined()
    expect(parseTargetsPanelReply("[1,2]")).toBeUndefined()
  })
})

describe("the built-in template", () => {
  test("groups by package in first-seen order with one Run button per target", () => {
    expect(groupTargets(targets).map((group) => [group.package, group.targets.length])).toEqual([["//src", 2], ["//", 1]])
    const html = renderTargetsPanel(targets)
    expect(html).toContain("data-testid=\"template-panel\"")
    expect(html.indexOf("<section data-package=\"//src\">")).toBeLessThan(html.indexOf("<section data-package=\"//\">"))
    expect(html).toContain("data-run=\"//src:lint\" data-testid=\"template-run-lint\"")
    expect(html).toContain("data-testid=\"template-run-detectSecrets\"")
    expect(html).toContain("smithers:\"run\"")
    expect(html.match(/<button/g)).toHaveLength(3)
  })

  test("escapes markup in labels", () => {
    const html = renderTargetsPanel([{ label: "//a:<b>", target: "X\"Y", kinds: [], package: "//a", name: "<b>" }])
    expect(html).not.toContain("<b>")
    expect(html).toContain("&lt;b&gt;")
    expect(html).toContain("X&quot;Y")
  })

  test("the default message counts", () => {
    expect(defaultTargetsMessage(1, "x")).toBe("Loaded 1 target for x.")
    expect(defaultTargetsMessage(82, "artsy/force")).toBe("Loaded 82 targets for artsy/force.")
  })
})
