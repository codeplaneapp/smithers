import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  baselineFromState,
  checkUiArchitecture,
  collectUiArchitectureState,
  parseModuleSpecifiers,
} from "./check-ui-architecture.mjs";

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function json(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function provenanceManifest() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: 2,
    policy: {
      registries: ["https://ui.shadcn.com", "https://elements.ai-sdk.dev"],
      collections: ["chat/shadcn", "primitives/shadcn", "agentic/ai-elements"],
      verification:
        "Each source file in an approved collection must name its upstream registry item URL in a lane manifest under provenance/. Entries record ported anatomy plus explicit omissions and divergences; this is provenance, not cryptographic verification.",
      entryFiles: [
        "provenance/chat-foundation.json",
        "provenance/agentic-reasoning-tool.json",
        "provenance/agentic-response-code.json",
        "provenance/agentic-plan-sources.json",
        "provenance/node-output-agentic.json",
      ],
    },
    entries: [],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smithers-ui-architecture-"));
  json(root, "package.json", { name: "smthrs", exports: {} });
  json(root, "packages/ui/package.json", {
    name: "@smthrs/ui",
    exports: { ".": "./src/index.ts" },
  });
  write(root, "packages/ui/src/index.ts", "export const ui = true;\n");
  json(root, "packages/ui/shadcn-provenance.json", provenanceManifest());
  json(root, "packages/components/package.json", {
    name: "@smthrs/components",
    exports: { ".": "./src/index.js" },
  });
  write(root, "packages/components/src/index.js", "export const workflowComponent = true;\n");
  json(root, "packages/gateway-react/package.json", {
    name: "@smthrs/gateway-react",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@smthrs/gateway-client": "workspace:*" },
  });
  write(root, "packages/gateway-react/src/index.ts", "export const gatewayHook = true;\n");
  json(root, "packages/gateway-ui/package.json", {
    name: "@smthrs/gateway-ui",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@smthrs/gateway-react": "workspace:*" },
  });
  write(root, "packages/gateway-ui/src/index.ts", 'export { useGatewayRun } from "@smthrs/gateway-react";\n');
  return root;
}

function snapshot(root) {
  const baseline = baselineFromState(collectUiArchitectureState(root, "smithers"));
  json(root, "scripts/ui-architecture-baseline.json", baseline);
  return baseline;
}

function check(root) {
  return checkUiArchitecture({
    root,
    kind: "smithers",
    baselinePath: "scripts/ui-architecture-baseline.json",
  });
}

test("module parser reads module specifiers without counting comments or templates", () => {
  const imports = parseModuleSpecifiers(`
    // import fake from "./community-registry.js"
    const prose = \`import fake from "./also-fake.js"\`;
    import type { A } from "./alpha.js";
    export { B } from "./beta.js";
    const lazy = import("./gamma.js");
    const old = require("./delta.js");
  `);
  assert.deepEqual(imports, ["./alpha.js", "./beta.js", "./delta.js", "./gamma.js"]);
});

test("an exact legacy allowlist passes", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = snapshot(root);
  assert.ok(baseline.allowedLegacyViolations.some((entry) => entry.startsWith("gateway-react-location ::")));
  assert.deepEqual(check(root), {
    ok: true,
    errors: [],
    state: collectUiArchitectureState(root, "smithers"),
  });
});

test("a compliant pack UI passes", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    ".smithers/ui/compliant.tsx",
    'import { useState } from "react"; import { Button } from "smthrs/ui"; import { helper } from "./helper"; export function Compliant() { const [open] = useState(false); return <Button>{helper(open)}</Button>; }\n',
  );
  write(root, ".smithers/ui/helper.ts", 'export function helper(open: boolean) { return open ? "Open" : "Closed"; }\n');
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("pack UIs may reuse local non-visual helpers", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    ".smithers/ui/compliant.tsx",
    'import { helper } from "../lib/helper"; export function Compliant() { return <div>{helper()}</div>; }\n',
  );
  write(root, ".smithers/lib/helper.ts", 'export function helper() { return "ready"; }\n');
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("pack UI imports are limited to the pack composition surface", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(
    root,
    "examples/ui/unsupported-import.tsx",
    'import { createRoot } from "react-dom/client"; export function UnsupportedImport() { return <div />; }\n',
  );
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /New architecture violation: pack-ui-imports :: examples\/ui\/unsupported-import\.tsx imports react-dom\/client/,
  );
});

test("a fresh pack UI style block fails", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(root, ".smithers/ui/fresh.tsx", 'export function Fresh() { return <style>{".x{}"}</style>; }\n');
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /New architecture violation: pack-ui-style-tag/);
});

test("a fresh pack UI theme module fails", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(root, "examples/ui/packTheme.ts", "export const packTheme = {};\n");
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /New architecture violation: pack-ui-theme-module/);
});

test("a fresh pack UI theme directory module fails", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(root, "examples/ui/theme/index.ts", "export const palette = {};\n");
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /New architecture violation: pack-ui-theme-module :: examples\/ui\/theme\/index\.ts is a bespoke theme or token module/,
  );
});

test("a baselined pack offender passes until it is edited", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = ".smithers/ui/legacy.tsx";
  write(root, path, 'export function Legacy() { return <style>{".x{}"}</style>; }\n');
  snapshot(root);
  assert.equal(check(root).ok, true);
  write(root, path, 'export function Legacy() { return <div style={{ color: "red" }} />; }\n');
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /New architecture violation: pack-ui-style-prop/);
  assert.match(result.errors.join("\n"), /Stale legacy allowlist entry/);
});

test("workflow-render hooks are distinct from public gateway data hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/xstate/package.json", {
    name: "@smthrs/xstate",
    exports: { ".": "./src/index.js" },
    dependencies: { react: "^19.0.0" },
  });
  write(
    root,
    "packages/xstate/src/index.js",
    "export function useSmithersMachine() { return React.useContext(SmithersContext); }\n",
  );
  const baseline = snapshot(root);
  assert.ok(!baseline.allowedLegacyViolations.some((entry) => entry.includes("packages/xstate/package.json")));
  assert.equal(check(root).ok, true);
});

test("agentic components are an approved typed props-driven UI layer", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "packages/ui/src/agentic/Reasoning.tsx",
    'import { Markdown } from "../primitives/markdown"; export function Reasoning(props: { text: string }) { return <div><Markdown content={props.text} /></div>; }\n',
  );
  write(
    root,
    "packages/ui/src/primitives/markdown.tsx",
    "export function Markdown(props: { content: string }) { return <div>{props.content}</div>; }\n",
  );
  const baseline = snapshot(root);
  assert.ok(
    !baseline.allowedLegacyViolations.some(
      (entry) => entry.startsWith("ui-layer-direction ::") && entry.includes("packages/ui/src/agentic/Reasoning.tsx"),
    ),
  );
  assert.equal(check(root).ok, true);
});

for (const [name, mutate, expected] of [
  [
    "visual imports in packages/components",
    (root) =>
      write(root, "packages/components/src/Visual.tsx", 'import { Button } from "radix-ui"; export { Button };\n'),
    "components-non-visual",
  ],
  [
    "CSS-in-JS visual declarations in packages/components",
    (root) =>
      write(
        root,
        "packages/components/src/Visual.tsx",
        'import styled from "styled-components"; export const Visual = styled.section`display: grid; color: red;`;\n',
      ),
    "components-non-visual",
  ],
  [
    "intrinsic visual JSX in packages/components",
    (root) => write(root, "packages/components/src/Visual.tsx", "export function Visual() { return <strong />; }\n"),
    "components-non-visual",
  ],
  [
    "lucide icons in packages/components",
    (root) =>
      write(
        root,
        "packages/components/src/Visual.tsx",
        'import { CircleIcon } from "lucide-react"; export { CircleIcon };\n',
      ),
    "components-non-visual",
  ],
  [
    "gateway hooks outside smithers/connected",
    (root) =>
      write(
        root,
        "packages/ui/src/chat/Chat.tsx",
        'import { useGatewayRun } from "@smthrs/gateway-react"; export function Chat() { return <div />; }\n',
      ),
    "gateway-react-location",
  ],
  [
    "gateway hooks in any other package",
    (root) => {
      json(root, "packages/consumer/package.json", {
        name: "@smthrs/consumer",
        exports: { ".": "./src/index.ts" },
      });
      write(root, "packages/consumer/src/index.ts", 'export { useGatewayRun } from "@smthrs/gateway-react";\n');
    },
    "gateway-react-location",
  ],
  [
    "gateway hooks from a public package entry outside src",
    (root) => {
      json(root, "packages/consumer/package.json", {
        name: "@smthrs/consumer",
        exports: { ".": "./index.ts" },
      });
      write(root, "packages/consumer/index.ts", 'export { useGatewayRun } from "@smthrs/gateway-react";\n');
    },
    "gateway-react-location",
  ],
  [
    "heavy adapters from the base UI entry",
    (root) => write(root, "packages/ui/src/index.ts", 'export * from "./adapters/monaco";\n'),
    "base-ui-export",
  ],
  [
    "transitively re-exported heavy adapters from the base UI entry",
    (root) => {
      write(root, "packages/ui/src/index.ts", 'export * from "./internal/editor";\n');
      write(root, "packages/ui/src/internal/editor.ts", 'export * from "../adapters/monaco";\n');
      write(root, "packages/ui/src/adapters/monaco.ts", 'export { default as Editor } from "@monaco-editor/react";\n');
    },
    "base-ui-export",
  ],
  [
    "untyped disconnected props",
    (root) =>
      write(
        root,
        "packages/ui/src/ai/Answer.tsx",
        "export function Answer(props) { return <div>{props.text}</div>; }\n",
      ),
    "disconnected-typed-props",
  ],
  [
    "untyped disconnected props on an unparenthesized arrow",
    (root) => write(root, "packages/ui/src/ai/Loose.tsx", "export const Loose = props => <div>{props.text}</div>;\n"),
    "disconnected-typed-props",
  ],
  [
    "untyped disconnected props on a default anonymous arrow",
    (root) => write(root, "packages/ui/src/ai/Loose.tsx", "export default props => <div>{props.text}</div>;\n"),
    "disconnected-typed-props",
  ],
  [
    "untyped disconnected props exported through an export list",
    (root) =>
      write(
        root,
        "packages/ui/src/ai/Answer.tsx",
        "function Answer(props) { return <div>{props.text}</div>; } export { Answer };\n",
      ),
    "disconnected-typed-props",
  ],
  [
    "runtime smithers-to-adapters imports",
    (root) => {
      write(root, "packages/ui/src/adapters/types.ts", "export const adapterValue = true;\n");
      write(
        root,
        "packages/ui/src/smithers/Card.tsx",
        'import { adapterValue } from "../adapters/types"; export function Card() { return <div>{String(adapterValue)}</div>; }\n',
      );
    },
    "adapter-types-only",
  ],
  [
    "missing official shadcn provenance",
    (root) =>
      write(root, "packages/ui/src/primitives/shadcn/button.tsx", "export function Button() { return <button />; }\n"),
    "shadcn-provenance",
  ],
  [
    "legacy shadcn provenance schema",
    (root) =>
      json(root, "packages/ui/shadcn-provenance.json", {
        version: 1,
        policy: {
          registry: "https://ui.shadcn.com",
          collections: ["chat/shadcn", "primitives/shadcn"],
        },
        entries: [],
      }),
    "shadcn-provenance",
  ],
  [
    "incomplete lane provenance",
    (root) => {
      write(
        root,
        "packages/ui/src/chat/MessageScroller.tsx",
        "export function MessageScroller() { return <div />; }\n",
      );
      json(root, "packages/ui/provenance/chat-foundation.json", []);
    },
    "shadcn-provenance",
  ],
  [
    "community shadcn provenance",
    (root) => {
      const path = "packages/ui/src/primitives/shadcn/button.tsx";
      write(root, path, "export function Button() { return <button />; }\n");
      json(root, "packages/ui/provenance/chat-foundation.json", [
        {
          file: "src/primitives/shadcn/button.tsx",
          exports: ["Button"],
          collection: "primitives/shadcn",
          registryItem: "https://community.example/r/button.json",
          ported: "partial-anatomy",
          omissions: [],
          divergences: [],
        },
      ]);
    },
    "shadcn-provenance",
  ],
  [
    "missing agentic lane provenance",
    (root) =>
      write(
        root,
        "packages/ui/src/agentic/CodeBlock.tsx",
        "export function CodeBlock(props: { code: string }) { return <pre>{props.code}</pre>; }\n",
      ),
    "shadcn-provenance",
  ],
  [
    "unapproved agentic registry provenance",
    (root) => {
      write(
        root,
        "packages/ui/src/agentic/CodeBlock.tsx",
        "export function CodeBlock(props: { code: string }) { return <pre>{props.code}</pre>; }\n",
      );
      json(root, "packages/ui/provenance/agentic-response-code.json", [
        {
          file: "src/agentic/CodeBlock.tsx",
          exports: ["CodeBlock"],
          collection: "agentic/ai-elements",
          registryItem: "https://example.com/components/code-block",
          ported: "partial-anatomy",
          omissions: [],
          divergences: [],
        },
      ]);
    },
    "shadcn-provenance",
  ],
  [
    "non-official component registries",
    (root) =>
      write(root, "packages/ui/src/chat/Community.tsx", 'import { Chat } from "@ai-elements/chat"; export { Chat };\n'),
    "official-shadcn-only",
  ],
  [
    "new files outside the target UI layers",
    (root) => write(root, "packages/ui/src/loose.ts", "export const loose = true;\n"),
    "ui-layer-placement",
  ],
  [
    "growth in a compatibility facade",
    (root) => write(root, "packages/gateway-ui/src/NewPanel.tsx", "export function NewPanel() { return <div />; }\n"),
    "compatibility-facade-file",
  ],
  [
    "a second public React hook package",
    (root) => {
      json(root, "packages/data-react/package.json", {
        name: "@smthrs/data-react",
        main: "index.js",
        dependencies: { react: "^19.0.0" },
      });
      write(root, "packages/data-react/index.js", "export function useData() { return null; }\n");
    },
    "single-public-hook-package",
  ],
  [
    "a public hook subpath outside src",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        exports: { "./use-data": "./use-data.ts" },
      });
      write(root, "packages/data/use-data.ts", "export function useData() { return null; }\n");
    },
    "single-public-hook-package",
  ],
  [
    "a CommonJS public hook entry",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        main: "index.cjs",
      });
      write(root, "packages/data/index.cjs", "module.exports.useData = function useData() { return null; };\n");
    },
    "single-public-hook-package",
  ],
  [
    "a CommonJS object public hook entry",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        main: "index.cjs",
      });
      write(root, "packages/data/index.cjs", "function useData() { return null; }\nmodule.exports = { useData };\n");
    },
    "single-public-hook-package",
  ],
  [
    "a direct CommonJS-assigned public hook entry",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        main: "index.cjs",
      });
      write(root, "packages/data/index.cjs", "function useData() { return null; }\nmodule.exports = useData;\n");
    },
    "single-public-hook-package",
  ],
  [
    "a TypeScript CommonJS public hook export assignment",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        main: "index.ts",
      });
      write(root, "packages/data/index.ts", "function useData() { return null; }\nexport = useData;\n");
    },
    "single-public-hook-package",
  ],
  [
    "an Object.defineProperty public hook entry",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        main: "index.cjs",
      });
      write(
        root,
        "packages/data/index.cjs",
        'function useData() { return null; }\nObject.defineProperty(exports, "useData", { enumerable: true, get: () => useData });\n',
      );
    },
    "single-public-hook-package",
  ],
  [
    "a default re-export from a hook-named module",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        exports: { ".": "./index.js" },
      });
      write(root, "packages/data/index.js", 'export { default } from "./useData.js";\n');
      write(root, "packages/data/useData.js", "export default function() { return null; }\n");
    },
    "single-public-hook-package",
  ],
  [
    "a public hook hidden behind an export-star entry",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        exports: { ".": "./index.js" },
      });
      write(root, "packages/data/index.js", "export * from './hooks.js';\n");
      write(
        root,
        "packages/data/hooks.js",
        "export * from './index.js';\nexport function useSecret() { return 'secret'; }\nexport function useData() { return null; }\n",
      );
    },
    "single-public-hook-package",
  ],
  [
    "a public hook hidden behind a runtime namespace re-export",
    (root) => {
      json(root, "packages/data/package.json", {
        name: "@smthrs/data",
        exports: { ".": "./index.js" },
      });
      write(root, "packages/data/index.js", 'export * as hooks from "./hooks.js";\n');
      write(root, "packages/data/hooks.js", "export function useData() { return null; }\n");
    },
    "single-public-hook-package",
  ],
  [
    "a second visual package",
    (root) => {
      json(root, "packages/dashboard/package.json", {
        name: "@smthrs/dashboard",
        main: "index.tsx",
      });
      write(root, "packages/dashboard/index.tsx", "export function Dashboard() { return <section />; }\n");
    },
    "single-visual-package",
  ],
  [
    "an unlisted component library in a new visual package",
    (root) => {
      json(root, "packages/dashboard/package.json", {
        name: "@smthrs/dashboard",
        exports: { ".": "./index.tsx" },
        dependencies: { "@fluentui/react-components": "1.0.0" },
      });
      write(
        root,
        "packages/dashboard/index.tsx",
        'import { Button } from "@fluentui/react-components"; export function Dashboard() { return <Button />; }\n',
      );
    },
    "single-visual-package",
  ],
  [
    "an undeclared new package cannot hide an unlisted component dependency",
    (root) => {
      json(root, "packages/dashboard/package.json", {
        name: "@smthrs/dashboard",
        dependencies: { "@fluentui/react-components": "1.0.0" },
      });
    },
    "Inventory packageExportSurfaces gained",
  ],
  [
    "a second package importing visual icons",
    (root) => {
      json(root, "packages/dashboard/package.json", {
        name: "@smthrs/dashboard",
        main: "index.tsx",
      });
      write(root, "packages/dashboard/index.tsx", 'export { CircleIcon } from "lucide-react";\n');
    },
    "single-visual-package",
  ],
  [
    "gateway-react imports through the umbrella package",
    (root) => write(root, "packages/gateway-react/src/umbrella.ts", 'export { gatewayKeys } from "smthrs";\n'),
    "gateway-react-direction",
  ],
  [
    "gateway-react depends on the umbrella package",
    (root) => {
      const manifest = JSON.parse(readFileSync(join(root, "packages/gateway-react/package.json"), "utf8"));
      manifest.dependencies["smthrs"] = "workspace:*";
      json(root, "packages/gateway-react/package.json", manifest);
    },
    "gateway-react-direction",
  ],
  [
    "a heavy widget outside adapters",
    (root) =>
      write(
        root,
        "packages/ui/src/ai/Editor.tsx",
        'import Editor from "@monaco-editor/react"; export function EditorView() { return <Editor />; }\n',
      ),
    "heavy-widget-location",
  ],
  [
    "ui-core importing opentui",
    (root) => {
      json(root, "packages/ui-core/package.json", {
        name: "@smthrs/ui-core",
        exports: { ".": "./src/index.ts" },
      });
      write(root, "packages/ui-core/src/index.ts", 'export { useKeyboard } from "@opentui/react";\n');
    },
    "ui-core-boundary",
  ],
  [
    "ui-core importing the web ui barrel",
    (root) => {
      json(root, "packages/ui-core/package.json", {
        name: "@smthrs/ui-core",
        exports: { ".": "./src/index.ts" },
      });
      write(root, "packages/ui-core/src/index.ts", 'export { Button } from "@smthrs/ui";\n');
    },
    "ui-core-boundary",
  ],
  [
    "ui-core referencing a DOM global outside the web platform adapter",
    (root) => {
      json(root, "packages/ui-core/package.json", {
        name: "@smthrs/ui-core",
        exports: { ".": "./src/index.ts" },
      });
      write(root, "packages/ui-core/src/index.ts", "export const width = window.innerWidth;\n");
    },
    "ui-core-boundary",
  ],
  [
    "tui-ui importing gateway-react",
    (root) => {
      json(root, "packages/tui-ui/package.json", {
        name: "@smthrs/tui-ui",
        exports: { ".": "./src/index.ts" },
      });
      write(root, "packages/tui-ui/src/index.ts", 'export { useGatewayRun } from "@smthrs/gateway-react";\n');
    },
    "tui-ui-boundary",
  ],
  [
    "tui-ui importing zustand",
    (root) => {
      json(root, "packages/tui-ui/package.json", {
        name: "@smthrs/tui-ui",
        exports: { ".": "./src/index.ts" },
      });
      write(
        root,
        "packages/tui-ui/src/index.ts",
        'import { create } from "zustand"; export const useStore = create(() => ({}));\n',
      );
    },
    "tui-ui-boundary",
  ],
]) {
  test(`representative violation fails: ${name}`, (context) => {
    const root = fixture();
    context.after(() => rmSync(root, { recursive: true, force: true }));
    snapshot(root);
    mutate(root);
    const result = check(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), new RegExp(expected));
  });
}

test("wildcard public export targets are expanded before checking for hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { "./*": "./src/*.js" },
  });
  write(root, "packages/data/src/constants.js", "export const value = 1;\n");
  snapshot(root);
  write(root, "packages/data/src/use-data.js", "export function useData() { return null; }\n");
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /single-public-hook-package/);
});

test("wildcard public exports do not mistake hook calls for hook exports", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { "./*": "./src/*.js" },
  });
  write(root, "packages/data/src/constants.js", "export const value = 1;\n");
  snapshot(root);
  write(
    root,
    "packages/data/src/read-context.js",
    "export function readContext() { return React.useContext(DataContext); }\n",
  );
  assert.equal(check(root).ok, true);
});

test("default hook re-exports are followed through intermediate modules", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.js" },
  });
  write(root, "packages/data/index.js", "export const data = true;\n");
  snapshot(root);
  write(root, "packages/data/index.js", 'export { default } from "./bridge.js";\n');
  write(root, "packages/data/bridge.js", 'export { default } from "./useData.js";\n');
  write(root, "packages/data/useData.js", "export default function() { return null; }\n");
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /single-public-hook-package/);
});

test("default re-exports do not expose unrelated named hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.js" },
  });
  write(root, "packages/data/index.js", 'export { default } from "./values.js";\n');
  write(root, "packages/data/values.js", "export default 42;\nexport function useInternal() { return null; }\n");
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("export-star barrels do not expose default hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.js" },
  });
  write(root, "packages/data/index.js", "export const data = true;\n");
  write(root, "packages/data/useData.js", "export default function() { return null; }\n");
  snapshot(root);
  write(root, "packages/data/index.js", 'export * from "./useData.js";\n');
  assert.equal(check(root).ok, true);
});

test("runtime namespace re-exports expose default hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.js" },
  });
  write(root, "packages/data/index.js", "export const data = true;\n");
  write(root, "packages/data/useData.js", "export default function useData() {}\n");
  snapshot(root);
  write(root, "packages/data/index.js", 'export * as hooks from "./useData.js";\n');
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /single-public-hook-package/);
});

test("default type-only declarations do not count as public runtime hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./useData.ts" },
  });
  write(root, "packages/data/useData.ts", "export const data = true;\n");
  snapshot(root);
  write(root, "packages/data/useData.ts", "export default interface Value { data: string }\n");
  assert.equal(check(root).ok, true);
});

test("type-only hook exports do not count as public runtime hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.ts" },
  });
  write(root, "packages/data/index.ts", "export const data = true;\n");
  write(root, "packages/data/types.ts", "export interface useSecret { value: string }\n");
  snapshot(root);
  write(
    root,
    "packages/data/index.ts",
    [
      "interface useData { value: string }",
      "type useResult = string;",
      "export type { useData };",
      "export { type useResult };",
      'export type { useSecret } from "./types.js";',
      'export type * from "./types.js";',
      'export type * as useTypes from "./types.js";',
      "",
    ].join("\n"),
  );
  assert.equal(check(root).ok, true);
});

test("type-only namespace re-exports do not expose runtime hooks", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/data/package.json", {
    name: "@smthrs/data",
    exports: { ".": "./index.ts" },
  });
  write(root, "packages/data/index.ts", "export const data = true;\n");
  write(root, "packages/data/hooks.ts", "export function useData() { return null; }\n");
  snapshot(root);
  write(root, "packages/data/index.ts", 'export type * as hooks from "./hooks.js";\n');
  assert.equal(check(root).ok, true);
});

for (const [name, source] of [
  ["zero-argument", "function useData() { return null; }\nObject.defineProperty();\n"],
  ["one-argument", "function useData() { return null; }\nObject.defineProperty(exports);\n"],
]) {
  test(`${name} Object.defineProperty calls do not fabricate public hooks`, (context) => {
    const root = fixture();
    context.after(() => rmSync(root, { recursive: true, force: true }));
    json(root, "packages/data/package.json", {
      name: "@smthrs/data",
      main: "index.cjs",
    });
    write(root, "packages/data/index.cjs", "module.exports.value = true;\n");
    snapshot(root);
    write(root, "packages/data/index.cjs", source);
    let result;
    assert.doesNotThrow(() => {
      result = check(root);
    });
    assert.equal(result.ok, true);
  });
}

test("valid official shadcn provenance passes", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = "packages/ui/src/primitives/shadcn/button.tsx";
  write(root, path, "export function Button() { return <button />; }\n");
  json(root, "packages/ui/provenance/chat-foundation.json", [
    {
      file: "src/primitives/shadcn/button.tsx",
      exports: ["Button"],
      collection: "primitives/shadcn",
      registryItem: "https://ui.shadcn.com/r/styles/new-york-v4/button.json",
      ported: "partial-anatomy",
      omissions: [],
      divergences: [],
    },
  ]);
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("the frozen version 2 provenance umbrella passes", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/ui/shadcn-provenance.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: 2,
    policy: {
      registries: ["https://ui.shadcn.com", "https://elements.ai-sdk.dev"],
      collections: ["chat/shadcn", "primitives/shadcn", "agentic/ai-elements"],
      entryFiles: [
        "provenance/chat-foundation.json",
        "provenance/agentic-reasoning-tool.json",
        "provenance/agentic-response-code.json",
        "provenance/agentic-plan-sources.json",
        "provenance/node-output-agentic.json",
      ],
      verification:
        "Each source file in an approved collection must name its upstream registry item URL in a lane manifest under provenance/. Entries record ported anatomy plus explicit omissions and divergences; this is provenance, not cryptographic verification.",
    },
    entries: [],
  });
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("CodeBlock can live in primitives with an agentic compatibility re-export", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "packages/ui/src/primitives/CodeBlock.tsx",
    "export function CodeBlock(props: { code: string }) { return <pre>{props.code}</pre>; }\n",
  );
  write(root, "packages/ui/src/agentic/CodeBlock.tsx", 'export { CodeBlock } from "../primitives/CodeBlock";\n');
  write(
    root,
    "packages/ui/src/primitives/markdown.tsx",
    'import { CodeBlock } from "./CodeBlock"; export function Markdown(props: { code: string }) { return <CodeBlock code={props.code} />; }\n',
  );
  json(root, "packages/ui/provenance/agentic-response-code.json", [
    {
      file: "src/agentic/CodeBlock.tsx",
      exports: ["CodeBlock"],
      collection: "agentic/ai-elements",
      registryItem: "https://elements.ai-sdk.dev/components/code-block",
      ported: "partial-anatomy",
      omissions: [],
      divergences: [],
    },
  ]);
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("primitives cannot import the agentic layer", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "packages/ui/src/agentic/CodeBlock.tsx",
    "export function CodeBlock(props: { code: string }) { return <pre>{props.code}</pre>; }\n",
  );
  json(root, "packages/ui/provenance/agentic-response-code.json", [
    {
      file: "src/agentic/CodeBlock.tsx",
      exports: ["CodeBlock"],
      collection: "agentic/ai-elements",
      registryItem: "https://elements.ai-sdk.dev/components/code-block",
      ported: "partial-anatomy",
      omissions: [],
      divergences: [],
    },
  ]);
  snapshot(root);
  write(
    root,
    "packages/ui/src/primitives/markdown.tsx",
    'import { CodeBlock } from "../agentic/CodeBlock"; export function Markdown(props: { code: string }) { return <CodeBlock code={props.code} />; }\n',
  );
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ui-layer-direction/);
});

test("type-only smithers-to-adapter imports pass", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(root, "packages/ui/src/adapters/types.ts", "export interface AdapterState { ready: boolean }\n");
  write(
    root,
    "packages/ui/src/smithers/Card.tsx",
    'import type { AdapterState } from "../adapters/types"; export function Card(props: AdapterState) { return <div>{String(props.ready)}</div>; }\n',
  );
  assert.equal(check(root).ok, true);
});

test("typed disconnected props and connected gateway imports pass", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "packages/ui/src/ai/Typed.tsx",
    "interface TypedProps { text: string } export const Typed: React.FC<TypedProps> = props => <div>{props.text}</div>;\n",
  );
  write(
    root,
    "packages/ui/src/smithers/connected/Live.tsx",
    'import { useGatewayRun } from "@smthrs/gateway-react"; export function Live(props: { runId: string }) { return <div>{String(useGatewayRun(props.runId))}</div>; }\n',
  );
  snapshot(root);
  assert.equal(check(root).ok, true);
});

test("compliant ui-core and tui-ui modules pass", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  json(root, "packages/ui-core/package.json", {
    name: "@smthrs/ui-core",
    exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
  });
  write(root, "packages/ui-core/src/index.ts", 'export { statusTone } from "./runs/statusMeta.ts";\n');
  write(
    root,
    "packages/ui-core/src/runs/statusMeta.ts",
    "export function statusTone(status: string) { return status; }\n",
  );
  json(root, "packages/tui-ui/package.json", {
    name: "@smthrs/tui-ui",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@opentui/core": "^0.4.2", "@opentui/react": "^0.4.2" },
  });
  write(root, "packages/tui-ui/src/index.ts", 'export { StatusPill } from "./StatusPill.tsx";\n');
  write(
    root,
    "packages/tui-ui/src/StatusPill.tsx",
    "/** @jsxImportSource @opentui/react */\nexport function StatusPill(props: { label: string }) { return <text>{props.label}</text>; }\n",
  );
  const baseline = snapshot(root);
  assert.ok(
    baseline.allowedLegacyViolations.some(
      (entry) => entry === "single-visual-package :: packages/tui-ui/package.json dependencies contains @opentui/core",
    ),
  );
  assert.equal(check(root).ok, true);
});

test("a disappeared violation must be removed from the allowlist", (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  snapshot(root);
  write(root, "packages/gateway-ui/src/index.ts", "export const facade = true;\n");
  const result = check(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Stale legacy allowlist entry/);
});
