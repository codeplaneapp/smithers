/**
 * Language-server payloads projected into public code-intelligence responses.
 *
 * @since 1.0.0
 */
/*
 * The Language Server Protocol shapes as far as Smithers reads them (LSP
 * 3.17), and the one conversion of each into the typed answers of
 * `LocalApp.ts`: 0-based, end-exclusive ranges become 1-based; a hover's
 * contents become one markdown string cut at the cap; a diagnostic's numeric
 * severity becomes its word. Two adapters speak the wire — the Bun host's
 * stdio session (`apps/ui/src/bun/lsp/LspSession.ts`) and the renderer's
 * cloud client over plue's relay (`apps/ui/src/mainview/state/CloudLspClient.ts`)
 * — and both convert HERE, so a hover reads the same whichever machine the
 * server runs on. Runtime-free: strings and numbers only.
 */
import { isRecord } from "@smthrs/canonical/Record"
import { LSP_HOVER_CAP_CHARS } from "./LocalApp.ts"
import type { LspDiagnostic, LspHover, LspRange, LspSeverity } from "./LocalApp.ts"

/**
 * The lsp position wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspPositionWire {
  readonly line: number
  readonly character: number
}
/**
 * The lsp range wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspRangeWire {
  readonly start: LspPositionWire
  readonly end: LspPositionWire
}
/**
 * The lsp diagnostic wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspDiagnosticWire {
  readonly range: LspRangeWire
  readonly message: string
  readonly severity?: number
  readonly code?: number | string
  readonly source?: string
  readonly relatedInformation?: unknown
}
/**
 * The lsp location wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspLocationWire {
  readonly uri: string
  readonly range: LspRangeWire
}
/**
 * The lsp location link wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspLocationLinkWire {
  readonly targetUri: string
  readonly targetRange: LspRangeWire
  readonly targetSelectionRange?: LspRangeWire
}
/**
 * The lsp marked string contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type LspMarkedString = string | { readonly language: string; readonly value: string }
/**
 * The lsp hover contents contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHoverContents = LspMarkedString | ReadonlyArray<LspMarkedString> | {
  readonly kind: string
  readonly value: string
}
/**
 * The lsp hover wire contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface LspHoverWire {
  readonly contents: LspHoverContents
  readonly range?: LspRangeWire
}

const SEVERITIES: Readonly<Record<number, LspSeverity>> = { 1: "error", 2: "warning", 3: "information", 4: "hint" }

/** 0-based, end-exclusive → 1-based, end-exclusive.
 * @since 1.0.0
 * @category conversions
 */
export const toWireRange = (range: LspRangeWire): LspRange => ({
  line: range.start.line + 1,
  character: range.start.character + 1,
  endLine: range.end.line + 1,
  endCharacter: range.end.character + 1
})

const markedString = (value: LspMarkedString): string =>
  typeof value === "string" ? value : `\`\`\`${value.language}\n${value.value}\n\`\`\``

/**
 * An absolute path in free text: a leading slash not glued to a word (so a
 * URL's `//host/…` and a relative `src/…` are left alone), then at least two
 * segments. Quotes, brackets, whitespace and `:` end it, so `'/x/y'` and
 * `/x/y.ts:12:3` keep their punctuation.
 */
const PATH_TOKEN = /(?<![A-Za-z0-9_.~/-])\/(?:[^\s"'`<>()[\]{}|:;,/]+\/)+[^\s"'`<>()[\]{}|:;,/]*/g

const lastSegment = (path: string): string => path.split("/").filter((segment) => segment !== "").at(-1) ?? ""

/**
 * The server's free text with the machine's filesystem taken out: a path
 * under the root becomes root-relative (the root itself `.`), any other
 * absolute path keeps only its last segment behind `…/`. The renderer, the
 * model and the `/ws` bus all read the result; nothing downstream sees
 * `/Users/<name>/…` or `/nix/store/…`.
 * @since 1.0.0
 * @category conversions
 */
export const redactHostPaths = (text: string, root: string): string =>
  text.replace(PATH_TOKEN, (token) => {
    const trailing = token.length > 1 && token.endsWith("/") ? "/" : ""
    const path = trailing === "" ? token : token.slice(0, -1)
    if (path === root) return "."
    if (path.startsWith(`${root}/`)) return `${path.slice(root.length + 1)}${trailing}`
    return `…/${lastSegment(path)}${trailing}`
  })

/** The hover's text as one markdown string, through `redact`, cut at the cap and saying so.
 * @since 1.0.0
 * @category conversions
 */
export const hoverContents = (
  contents: LspHoverContents,
  redact: (text: string) => string = (text) => text
): LspHover => {
  const joined = Array.isArray(contents)
    ? (contents as ReadonlyArray<LspMarkedString>).map(markedString).join("\n\n")
    : isRecord(contents) && "kind" in contents
    ? String(contents.value)
    : markedString(contents as LspMarkedString)
  const text = redact(joined)
  const truncated = text.length > LSP_HOVER_CAP_CHARS
  return { contents: truncated ? text.slice(0, LSP_HOVER_CAP_CHARS) : text, truncated }
}

/** One diagnostic as the card and the model see it, its message through `redact`; related information stays with the server.
 * @since 1.0.0
 * @category conversions
 */
export const toDiagnostic = (
  item: LspDiagnosticWire,
  redact: (text: string) => string = (text) => text
): LspDiagnostic => ({
  ...toWireRange(item.range),
  severity: SEVERITIES[item.severity ?? 1] ?? "error",
  message: redact(item.message),
  ...(item.source === undefined ? {} : { source: item.source }),
  ...(item.code === undefined ? {} : { code: String(item.code) })
})

/**
 * A `file:` URI under `rootUri` as a root-relative path, or null when it
 * points elsewhere (a linked package, a lib.d.ts): a target the renderer
 * cannot open as a file card of this repository is counted, never invented
 * away. Percent-escapes are decoded; a URI that is not a file URI is null.
 * @since 1.0.0
 * @category conversions
 */
export const relativeToRoot = (uri: string, rootUri: string): string | null => {
  const root = rootUri.endsWith("/") ? rootUri.slice(0, -1) : rootUri
  if (!uri.startsWith(`${root}/`)) return null
  try {
    const relative = decodeURIComponent(uri.slice(root.length + 1))
    return relative === "" ? null : relative
  } catch {
    return null
  }
}

/** The one `initialize` capability set both adapters announce: markdown hovers, no related information, full-text sync.
 * @since 1.0.0
 * @category constants
 */
export const LSP_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    publishDiagnostics: { relatedInformation: false, versionSupport: true }
  },
  workspace: { configuration: true, workspaceFolders: true }
} as const
