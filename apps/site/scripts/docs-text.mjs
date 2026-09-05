/** Convert the site's supported MDX components to portable Markdown. */
export function docsText(source, { raw = {}, versions = {} } = {}) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "")
  // Preserve code verbatim: its imports are part of the example, not MDX setup.
  return body.split(/(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$)/gm).map((part, index) => {
    if (index % 2 === 1) return part
    const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ""
    return part
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/<DocsDiagram\b[\s\S]*?\/>/g, (tag) => `**${attr(tag, "title")}**\n\n${attr(tag, "caption")}`)
      .replace(/<LinkCard\b[\s\S]*?\/>/g, (tag) => `- [${attr(tag, "title")}](${attr(tag, "href")}): ${attr(tag, "description")}`)
      .replace(/<LinkButton\b([^>]*)>([^<]*)<\/LinkButton>/g, (_, attrs, label) => `[${label}](${attr(attrs, "href")})`)
      .replace(/<Code\b[\s\S]*?\/>/g, (tag) => {
        const name = tag.match(/\bcode=\{(\w+)\}/)?.[1]
        const literal = tag.match(/\bcode=\{`([\s\S]*?)`\}/)?.[1]
        let code = name === undefined ? literal : raw[name]
        if (code === undefined) throw new Error(`Cannot export Code component: ${tag}`)
        if ((attr(tag, "lang") || "text") === "text") code = code.split("\n").map((line) => line.trimEnd()).join("\n")
        return `\n\`\`\`${attr(tag, "lang") || "text"}\n${code.trimEnd()}\n\`\`\`\n`
      })
      .replace(/<img\b[^>]*\/>/g, (tag) => `![${attr(tag, "alt")}](${attr(tag, "src")})`)
      .replace(/<TabItem\b[^>]*label="([^"]+)"[^>]*>/g, "\n**$1**\n")
      .replace(/<\/?(?:CardGrid|FileTree|Steps|Tabs|TabItem)\b[^>]*>/g, "")
      .replace(/\{versions\.(\w+)\}/g, (_, key) => {
        if (!(key in versions)) throw new Error(`Unknown version field: ${key}`)
        return String(versions[key])
      })
      .replace(/^[ \t]+$/gm, "")
  }).join("").replace(/\n{3,}/g, "\n\n").trim()
}
