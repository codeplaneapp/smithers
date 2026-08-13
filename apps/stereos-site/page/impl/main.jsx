/**
 * The Implementation tab: a browser over the sources that actually implement
 * this demo.
 *
 * The tree, the code pane, the cards, and the badges are the shipped
 * components from `smthrs/ui` — `FileTree` and `CodeBlock` are real exports of
 * the published library, not lookalikes built here. The only local code is the
 * highlighter adapter: `build.mjs` tokenizes every file with Shiki at build
 * time for both themes, and `CodeBlock`'s `highlight` seam reads those tokens,
 * so the page ships no highlighter and fetches nothing at runtime.
 */
import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CodeBlock,
  CodeBlockFilename,
  CodeBlockHeader,
  FileTree,
  SmithersUiStyles,
  resolveTheme,
  subscribeTheme,
} from "smthrs/ui";
// Written by build.mjs before this module is bundled, and inlined here so the
// tab is one lazy-loaded request.
import { files, palette } from "../../site/impl-files.js";

const GITHUB = "https://github.com/smithersai/smithers/blob/main/apps/stereos-site";
const DEFAULT_PATH = "demo/guard.ts";

/** The house theme contract, as a React store. */
function useTheme() {
  return useSyncExternalStore(
    subscribeTheme,
    () => resolveTheme(),
    () => "light",
  );
}

function App() {
  const theme = useTheme();
  const [selected, setSelected] = useState(DEFAULT_PATH);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), []);
  const file = byPath.get(selected) ?? byPath.get(DEFAULT_PATH);

  // Rebuild the plain source only when the selection changes: CodeBlock copies
  // this string, and the tokens carry the display form.
  const code = useMemo(
    () => (file ? file[theme].map((line) => line.map(([text]) => text).join("")).join("\n") : ""),
    [file, theme],
  );

  // The highlighter seam. Returns the prebuilt tokens for the file on screen.
  const highlight = useMemo(
    () => () => (file ? file[theme].map((line) => line.map(([text, slot]) => ({ text, color: palette[slot] }))) : null),
    [file, theme],
  );

  useEffect(() => {
    const wanted = decodeURIComponent(location.hash.replace(/^#impl\/?/, ""));
    if (wanted && byPath.has(wanted)) setSelected(wanted);
  }, [byPath]);

  if (!file) return null;
  return (
    <div>
      <SmithersUiStyles />
      <div className="impl-split">
        <Card>
          <CardHeader>
            <CardTitle>
              {files.length} files <Badge variant="secondary">apps/stereos-site</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent style={{ maxHeight: 560, overflow: "auto" }}>
            <FileTree
              data-testid="impl-tree"
              nodes={files.map((entry) => ({ path: entry.path }))}
              selected={file.path}
              onSelect={setSelected}
              renderAffordance={(node) => (
                <span style={{ fontSize: 11, opacity: 0.6 }}>{byPath.get(node.path)?.lines ?? ""}</span>
              )}
            />
          </CardContent>
        </Card>

        <Card data-testid="impl-viewer" data-path={file.path}>
          <CodeBlockHeader>
            <CodeBlockFilename name={file.path} />
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
              <span style={{ opacity: 0.65 }}>
                {file.lines} lines · {(file.bytes / 1024).toFixed(1)} KiB
              </span>
              <a href={`${GITHUB}/${file.path}`} target="_blank" rel="noopener">
                GitHub
              </a>
            </span>
          </CodeBlockHeader>
          <CodeBlock
            key={`${file.path}:${theme}`}
            code={code}
            language={file.lang}
            highlight={highlight}
            showLineNumbers
            style={{ maxHeight: 560, overflow: "auto" }}
          />
        </Card>
      </div>
      <style>{`
        .impl-split { display: grid; gap: 14px; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); }
        @media (max-width: 820px) { .impl-split { grid-template-columns: minmax(0, 1fr); } }
      `}</style>
    </div>
  );
}

createRoot(document.getElementById("impl-root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
