import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"

/** Heavy editor adapter boundary: loaded only when a World document is visible. */
export function MarkdownEditorSurface({
  value,
  resetKey,
  label,
  onChange
}: {
  readonly value: string
  readonly resetKey: string
  readonly label: string
  readonly onChange: (value: string) => void
}) {
  return (
    <>
      <MarkdownEditorStyles />
      <MarkdownEditor value={value} resetKey={resetKey} aria-label={label} onChange={onChange} />
    </>
  )
}
