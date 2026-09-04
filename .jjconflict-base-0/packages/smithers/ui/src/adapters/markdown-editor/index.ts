/**
 * `@smthrs/ui/adapters/markdown-editor`
 *
 * The shared Milkdown Crepe WYSIWYG markdown editor. It ships as a heavy
 * `@milkdown/*` adapter behind this explicit subpath (never the base `ui`
 * barrel) so importing the base component library never pulls the editor
 * runtime. Render {@link MarkdownEditorStyles} once to ship the Crepe theme CSS
 * through the UI style injector; every {@link MarkdownEditor} also self-injects
 * it in the browser as a fallback.
 */
export {
  MarkdownEditor,
  MarkdownEditorStyles,
  markdownEditorCss,
  MARKDOWN_EDITOR_STYLE_ATTR,
  supportsRichTextEditing,
  type MarkdownEditorError,
  type MarkdownEditorErrorCode,
  type MarkdownEditorHandle,
  type MarkdownEditorModule,
  type MarkdownEditorProps,
} from "./MarkdownEditor";
