/*
 * The tool-echo scrub: a weak model sometimes writes its tool call INTO the
 * reply text — `{"action":"execute","name":"repos.watch","args":""}` rendered
 * as prose — instead of emitting it on the tool channel. That text is wire
 * debris, never legitimate prose, so the renderer strips it. The STORE keeps
 * the raw text (the dev-tools panel shows the truth); only the bubble is
 * scrubbed. Nothing here ever EXECUTES a scrubbed blob: text is not a tool
 * call, and treating it as one would open a prompt-injection door.
 */

// TODO(shared): move to a shared package (copied from apps/ui/src/mainview/state/MessageScrub.ts)

const TOOL_ECHO_STARTS = ["{\"action\"", "{ \"action\""] as const

/** The end of the JSON object opening at `start`, or undefined when unbalanced. */
const balancedEnd = (text: string, start: number): number | undefined => {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === "\\") index += 1
      else if (char === "\"") inString = false
      continue
    }
    if (char === "\"") inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

/** True when the blob parses and looks like a commands-tool call. */
const isToolEcho = (blob: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(blob)
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "action" in parsed &&
      (parsed.action === "execute" || parsed.action === "list")
    )
  } catch {
    return false
  }
}

export const scrubToolEcho = (text: string): string => {
  let out = text
  for (const starter of TOOL_ECHO_STARTS) {
    let cursor = out.indexOf(starter)
    while (cursor !== -1) {
      const end = balancedEnd(out, cursor)
      if (end !== undefined && isToolEcho(out.slice(cursor, end))) {
        out = `${out.slice(0, cursor)}${out.slice(end)}`
        cursor = out.indexOf(starter, cursor)
      } else {
        cursor = out.indexOf(starter, cursor + 1)
      }
    }
  }
  // Collapse the seams a removal leaves behind, without touching real prose.
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}
