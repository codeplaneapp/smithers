/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { MarkdownEditor as ShippedMarkdownEditor, type MarkdownEditorHandle } from "smthrs/ui/adapters/markdown-editor";

export function MarkdownEditor({
  value,
  readOnly = false,
  onChange,
  resetKey,
  compact = false,
}: {
  value: string;
  readOnly?: boolean;
  onChange?: (markdown: string) => void;
  resetKey?: string;
  compact?: boolean;
}) {
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    if (readOnly) editorRef.current?.setMarkdown(value);
  }, [readOnly, value]);

  return (
    <div className={"editor-frame" + (compact ? " compact" : "") + (readOnly ? " readonly" : "")}>
      <ShippedMarkdownEditor
        ref={editorRef}
        className="crepe-host"
        aria-label="markdown editor"
        value={value}
        readOnly={readOnly}
        onChange={onChange}
        resetKey={resetKey}
      />
    </div>
  );
}
