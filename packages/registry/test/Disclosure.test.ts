import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  BodyRefMarkdown,
  FlowDescriptor,
  Provenance,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput
} from "../src/Descriptor.ts"
import * as Disclosure from "../src/Disclosure.ts"

const descriptor = (
  name: string,
  description: string,
  modelInvocable = true
): FlowDescriptor =>
  new FlowDescriptor({
    name,
    description,
    modelInvocable,
    body: new BodyRefMarkdown({
      path: "/private/DO-NOT-DISCLOSE-body.md",
      baseDirectory: "/private/DO-NOT-DISCLOSE-base"
    }),
    input: new SchemaRefMarkdownArgs({}),
    output: new SchemaRefMarkdownOutput({}),
    model: Option.none(),
    flows: [],
    capabilities: ["DO-NOT-DISCLOSE-capability"],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    path: "/private/DO-NOT-DISCLOSE-path.md",
    frontmatter: { secret: "DO-NOT-DISCLOSE-frontmatter" },
    provenance: new Provenance({
      source: "DO-NOT-DISCLOSE-provenance",
      root: "/private/DO-NOT-DISCLOSE-root"
    })
  })

describe("Disclosure", () => {
  it("renders model-invocable entries as a sorted agentskills XML block", () => {
    expect(
      Disclosure.toXml([
        descriptor("zebra", "Zebra flow"),
        descriptor("alpha", "Alpha flow")
      ])
    ).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>alpha</name>",
      "    <description>Alpha flow</description>",
      "  </skill>",
      "  <skill>",
      "    <name>zebra</name>",
      "    <description>Zebra flow</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it("escapes XML metacharacters in names and descriptions", () => {
    expect(Disclosure.toXml([descriptor("a<&>\"'", "b<&>\"'")])).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>a&lt;&amp;&gt;&quot;&apos;</name>",
      "    <description>b&lt;&amp;&gt;&quot;&apos;</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it("keeps model-hidden entries in autocomplete while excluding them from XML", () => {
    const hidden = descriptor("hidden", "Only slash invocation", false)

    expect(Disclosure.toEntries([hidden])).toEqual([
      { name: "hidden", description: "Only slash invocation" }
    ])
    expect(Disclosure.toXml([hidden])).toBe("<available_skills>\n</available_skills>")
  })

  it("sorts entries by name while preserving equal-name order", () => {
    expect(
      Disclosure.toEntries([
        descriptor("zebra", "Zebra flow"),
        descriptor("alpha", "First alpha flow"),
        descriptor("alpha", "Alpha flow")
      ])
    ).toEqual([
      { name: "alpha", description: "First alpha flow" },
      { name: "alpha", description: "Alpha flow" },
      { name: "zebra", description: "Zebra flow" }
    ])
  })

  it("keeps entries that already arrive in name order", () => {
    expect(
      Disclosure.toEntries([
        descriptor("alpha", "Alpha flow"),
        descriptor("zebra", "Zebra flow")
      ])
    ).toEqual([
      { name: "alpha", description: "Alpha flow" },
      { name: "zebra", description: "Zebra flow" }
    ])
  })

  it("renders a single entry", () => {
    expect(Disclosure.toEntries([descriptor("only", "The only flow")])).toEqual([
      { name: "only", description: "The only flow" }
    ])
    expect(Disclosure.toXml([descriptor("only", "The only flow")])).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>only</name>",
      "    <description>The only flow</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it("renders an exact empty block", () => {
    expect(Disclosure.toXml([])).toBe("<available_skills>\n</available_skills>")
  })

  it("does not disclose descriptor metadata", () => {
    const rendered = Disclosure.toXml([descriptor("public", "Public description")])

    expect(rendered).not.toContain("DO-NOT-DISCLOSE")
  })
})
