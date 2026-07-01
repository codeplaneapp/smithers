/** @jsxImportSource react */
// Milkdown Crepe WYSIWYG markdown editor wrapper. The parent injects the
// generated Crepe CSS string; this component only owns lifecycle and read-only
// state.
import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";

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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const key = resetKey ?? (readOnly ? value : "editor");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    const crepe = new Crepe({ root: host, defaultValue: value });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (!readOnly) onChangeRef.current?.(markdown);
      });
    });
    void crepe.create().then(() => {
      if (destroyed) return;
      if (readOnly) crepe.setReadonly(true);
    });
    return () => {
      destroyed = true;
      void crepe.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readOnly]);

  return (
    <div className={"editor-frame" + (compact ? " compact" : "") + (readOnly ? " readonly" : "")}>
      <div className="crepe-host" data-testid="cw-editor" ref={hostRef} />
    </div>
  );
}
