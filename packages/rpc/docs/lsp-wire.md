# LSP host paths

`redactHostPaths(text, root)` recognizes slash-delimited absolute paths with at
least two segments and `file://` URIs, including markdown links. Percent escapes
are decoded. Local paths under `root` become relative; the root becomes `.`.
Other paths become `…/<last segment>`, or `…` when fewer than three segments
remain. Bare home directories such as `/Users/alice` and `/home/alice/` become `…`.
File URI authorities, queries and fragments are discarded. Malformed escapes
become `…`.

For root `/repo/project`, `/repo/project/src/a.ts` becomes `src/a.ts`, and
`[a](file:///Users/alice/private/a.ts#L12)` becomes `[a](…/a.ts)`.
HTTP(S) links and relative paths remain unchanged. This is token-based redaction;
Windows paths and paths containing unescaped whitespace are unsupported.

`relativeToRoot(uri, rootUri)` accepts absolute `file://` URIs with matching
authorities. It compares decoded path segments and returns a nonempty relative
path only for a strict descendant of the root. Queries and fragments are omitted.
Both paths reject malformed escapes, dot segments, empty segments, encoded
separators, backslashes and NULs before URL normalization. The root may have one
trailing slash. Unsupported URIs and unsafe or out-of-root paths return `null`.
