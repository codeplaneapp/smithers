import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Badge,
  Button,
  CodeBlock,
  CodeBlockFilename,
  CodeBlockHeader,
  EmptyState,
  FileTree,
  resolveTheme,
  SmithersUiStyles,
  subscribeTheme,
} from "smthrs/ui";
import { sources } from "#sources";

/**
 * The Implementation tab: every source file behind this page, browsable.
 *
 * The tree and the viewer are `FileTree` and `CodeBlock` from `smthrs/ui`, the
 * same shipped component library the run UI on the demo host uses. Highlighting
 * is Shiki, tokenized at build time for both themes, and handed to `CodeBlock`
 * through its `highlight` seam, so the browser ships no highlighter.
 */

const GITHUB = "https://github.com/smithersai/smithers/blob/main/examples/stereos-sandbox-provider";

/** Track the resolved house theme so the tokens match the page's palette. */
function useTheme() {
  return useSyncExternalStore(subscribeTheme, resolveTheme, () => "light");
}

export function Sources() {
  const paths = useMemo(() => Object.keys(sources.files), []);
  const [selected, setSelected] = useState(() => paths[0] ?? null);
  const theme = useTheme();
  const file = selected ? sources.files[selected] : null;

  // Deep links: #impl/real/stereos-provider.ts opens that file directly.
  useEffect(() => {
    const fromHash = () => {
      const path = decodeURIComponent(location.hash.replace(/^#impl\/?/, ""));
      if (path && sources.files[path]) setSelected(path);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // CodeBlock's highlighter seam: return the build-time tokens for the file on
  // screen, colored for the theme in force. Returning null falls back to plain
  // text, which is what an unknown language gets.
  const highlight = useMemo(() => {
    if (!file) return undefined;
    const palette = theme === "dark" ? sources.palettes.dark : sources.palettes.light;
    const colors = theme === "dark" ? file.dark : file.light;
    return () =>
      file.text.map((line, index) =>
        line.map((text, token) => ({ text, color: palette[colors[index][token]] ?? undefined })),
      );
  }, [file, theme]);

  return (
    <div className="impl">
      <SmithersUiStyles />
      <div className="card impl-tree">
        <div className="cap">
          <span>{paths.length} files</span>
          <Badge variant="outline">smthrs/ui FileTree</Badge>
        </div>
        <div className="body">
          <FileTree nodes={paths} selected={selected} onSelect={setSelected} />
        </div>
      </div>

      <div className="card impl-view">
        {file ? (
          <>
            <CodeBlockHeader>
              <CodeBlockFilename name={selected} />
              <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                <span className="mono impl-bytes">{file.bytes} bytes</span>
                <Button asChild size="sm" variant="outline">
                  <a href={`${GITHUB}/${selected}`} target="_blank" rel="noopener">
                    GitHub
                  </a>
                </Button>
              </span>
            </CodeBlockHeader>
            <CodeBlock
              key={`${selected}:${theme}`}
              code={file.text.map((line) => line.join("")).join("\n")}
              language={file.lang}
              showLineNumbers
              highlight={highlight}
              data-testid="impl-code"
              data-path={selected}
            />
          </>
        ) : (
          <EmptyState title="No file selected" description="Pick a file in the tree." />
        )}
      </div>
    </div>
  );
}
