/**
 * Progressive-disclosure projections for registry entries.
 *
 * Implements the model-context projection in
 * [Flow Registry](../../../docs/specs/Concepts/Flow%20Registry.md).
 *
 * @since 0.1.0
 */
import type { FlowDescriptor } from "./Descriptor.ts"

/**
 * Escapes text for use as XML character data.
 *
 * @since 0.1.0
 * @category utilities
 */
const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

/**
 * Projects descriptors into slash-autocomplete entries.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toEntries = (
  entries: ReadonlyArray<FlowDescriptor>
): ReadonlyArray<{ readonly name: string; readonly description: string }> =>
  entries
    .map(({ name, description }) => ({ name, description }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

/**
 * Renders model-invocable descriptors as an agentskills-style XML block.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toXml = (entries: ReadonlyArray<FlowDescriptor>): string => {
  const visible = toEntries(entries.filter((entry) => entry.modelInvocable))

  if (visible.length === 0) {
    return "<available_skills>\n</available_skills>"
  }

  return [
    "<available_skills>",
    ...visible.flatMap(({ name, description }) => [
      "  <skill>",
      `    <name>${escapeXml(name)}</name>`,
      `    <description>${escapeXml(description)}</description>`,
      "  </skill>"
    ]),
    "</available_skills>"
  ].join("\n")
}
