#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".jj",
  ".smithers",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
  "tmp",
  "ui-dist",
]);
const UI_PACKAGES = new Set([
  "@smthrs/gateway-react",
  "@smthrs/gateway-ui",
  "@smthrs/ui",
  "@smthrs/ui-styleguide",
  "smthrs/gateway-react",
  "smthrs/gateway-ui",
  "smthrs/ui",
  "smthrs/ui-styleguide",
]);
// Workflow-render hooks execute inside the reconciler and are not gateway/UI
// data hooks. Keep this exception explicit so new public React hook packages
// still fail the single-hook-package policy by default.
const WORKFLOW_RENDER_HOOK_PACKAGES = new Set(["@smthrs/xstate"]);
const LEGACY_UI_PACKAGES = new Set([
  "@smthrs/gateway-ui",
  "@smthrs/ui-styleguide",
  "smthrs/gateway-ui",
  "smthrs/ui-styleguide",
]);
const VISUAL_DEPENDENCY_PREFIXES = [
  "@ai-elements",
  "@chakra-ui",
  "@headlessui",
  "@heroui",
  "@mui",
  "@nextui-org",
  "@opentui",
  "@radix-ui",
  "@shadcn",
  "antd",
  "daisyui",
  "flowbite",
  "lucide-react",
  "mantine",
  "radix-ui",
  "semantic-ui",
  "shadcnio",
];
const FORBIDDEN_REGISTRY_PREFIXES = ["@ai-elements", "@shadcn", "shadcnio"];
const HEAVY_DEPENDENCY_PREFIXES = [
  "@codemirror/",
  "@milkdown/",
  "@monaco-editor/",
  "@pierre/",
  "@replit/codemirror-vim",
  "@xterm/",
  "@xyflow/",
  "codemirror",
  "dagre",
  "mermaid",
  "monaco-editor",
  "shiki",
];
// ui-core (packages/ui-core/src/) is the isomorphic headless product layer:
// zero DOM, zero opentui, zero react-dom, and it must not reach into the
// platform-visual web packages. `react-dom`/`@opentui` are checked by prefix
// (subpaths like `react-dom/client` still count); the smthrs
// UI packages are checked by exact base package.
const UI_CORE_FORBIDDEN_PREFIXES = ["@opentui", "react-dom"];
const UI_CORE_FORBIDDEN_PACKAGES = new Set(["@smthrs/gateway-ui", "@smthrs/ui", "smthrs/gateway-ui", "smthrs/ui"]);
// DOM globals are checked lexically (not just via import specifiers) since a
// global like `window` needs no import statement. `src/platform/web*` is the
// carve-out for the (future) web Platform adapter implementations, which are
// necessarily DOM-coupled; everything else in ui-core stays platform-neutral.
const UI_CORE_DOM_GLOBALS = new Set(["document", "localStorage", "navigator", "window"]);
const UI_CORE_WEB_ADAPTER_PREFIX = "packages/ui-core/src/platform/web";

// tui-ui (packages/tui-ui/src/) is the opentui leaf component library:
// props-in/callbacks-out, no business logic, no gateway data access, and no
// zustand stores of its own.
const TUI_UI_FORBIDDEN_PACKAGES = new Set([
  "@smthrs/gateway-client",
  "@smthrs/gateway-react",
  "@smthrs/ui-core",
  "smthrs/gateway-client",
  "smthrs/gateway-react",
  "smthrs/ui-core",
  "zustand",
]);
const DUPLICATE_WRAPPER_NAMES = new Set([
  "alert",
  "avatar",
  "badge",
  "button",
  "card",
  "checkbox",
  "dialog",
  "dropdown-menu",
  "empty-state",
  "input",
  "label",
  "popover",
  "progress",
  "row-button",
  "scroll-area",
  "select",
  "separator",
  "skeleton",
  "spinner",
  "status-pill",
  "table",
  "tabs",
  "textarea",
  "tooltip",
]);
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const INVENTORY_KEYS = [
  "heavyWidgetDependencies",
  "legacyPackageUsage",
  "localDuplicateWrappersAndIcons",
  "packageExportSurfaces",
  "styleEntryPoints",
  "uiImports",
];
const SHADCN_DIRECTORIES = ["packages/ui/src/chat/shadcn", "packages/ui/src/primitives/shadcn"];
// The frozen agentic-ui program (freeze v2, integrationContract E) sanctions
// exactly one new gateway-ui file per gateway lane; each lane adds ONLY its own
// file to this set in its own branch, and the blanket legacy-facade rule below
// (which predates the program) would otherwise reject it outright. The closure
// lane also sanctions MonitorButton.tsx: it predates the tightened guard (so it
// was never baselined) and already conforms to the program profile, importing
// only the @smthrs/ui barrel plus its local theme module.
const SANCTIONED_GATEWAY_UI_PROGRAM_FILES = new Set([
  "packages/gateway-ui/src/CronCalendar.tsx",
  "packages/gateway-ui/src/GatewayApprovals.tsx",
  "packages/gateway-ui/src/GatewayCheckpointControls.tsx",
  "packages/gateway-ui/src/HijackTerminal.tsx",
  "packages/gateway-ui/src/OneshotSurface.tsx",
  "packages/gateway-ui/src/MonitorButton.tsx",
  "packages/gateway-ui/src/SmithersCanvasNode.tsx",
  "packages/gateway-ui/src/hijack.ts",
]);
const CANONICAL_STYLEGUIDE_FILES = new Set([
  "packages/ui-styleguide/src/SmithersTheme.ts",
  "packages/ui-styleguide/src/TerminalPalette.ts",
  "packages/ui-styleguide/src/ThemeSyntaxId.ts",
  "packages/ui-styleguide/src/ThemeVariantTokens.ts",
  "packages/ui-styleguide/src/contrastRatio.ts",
  "packages/ui-styleguide/src/mixColors.ts",
  "packages/ui-styleguide/src/paletteThemeCss.ts",
  "packages/ui-styleguide/src/serializeThemeVariant.ts",
  "packages/ui-styleguide/src/standaloneThemeCss.ts",
  "packages/ui-styleguide/src/themeRegistry.ts",
  "packages/ui-styleguide/src/themeTokens.ts",
  "packages/ui-styleguide/src/themes/catppuccin.ts",
  "packages/ui-styleguide/src/themes/fucory.ts",
  "packages/ui-styleguide/src/themes/github.ts",
  "packages/ui-styleguide/src/themes/gruvbox.ts",
  "packages/ui-styleguide/src/themes/nightOwl.ts",
  "packages/ui-styleguide/src/themes/one.ts",
  "packages/ui-styleguide/src/themes/rosePine.ts",
  "packages/ui-styleguide/src/themes/solarized.ts",
]);
// Sanctioned program files are gateway-data bindings: they may import
// @smthrs/gateway-react (data hooks) in addition to the
// @smthrs/ui barrel.
const SANCTIONED_GATEWAY_UI_PROGRAM_SPECIFIERS = new Set([
  "@smthrs/ui",
  "@smthrs/gateway-react",
  "smthrs/ui",
  "smthrs/gateway-react",
]);
// The frozen agentic-ui program assigns these component files to lanes whose
// CSS fragment lives in the lane's own directory (integrationContract A), so
// these cross-layer fragment edges are sanctioned.
const SANCTIONED_UI_LAYER_EDGES = new Set([
  "packages/ui/src/primitives/CodeBlock.tsx -> ../agentic/reasoningToolsCss",
  "packages/ui/src/chat/Attachment.tsx -> ../prompt/promptAttachmentsCss",
]);
// The frozen agentic-ui program exports component-anatomy hooks
// (usePromptInputAttachments, useMessageScroller, ...) from the
// @smthrs/ui barrel (integrationContract B), so the
// single-public-hook rule does not apply to its root entry.
const HOOK_EXPORT_EXEMPT_PACKAGES = new Set(["@smthrs/ui"]);
const SHADCN_PROVENANCE_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const SHADCN_PROVENANCE_REGISTRIES = ["https://ui.shadcn.com", "https://elements.ai-sdk.dev"];
const SHADCN_PROVENANCE_COLLECTIONS = ["chat/shadcn", "primitives/shadcn", "agentic/ai-elements"];
const SHADCN_PROVENANCE_ENTRY_FILES = [
  "provenance/chat-foundation.json",
  "provenance/agentic-reasoning-tool.json",
  "provenance/agentic-response-code.json",
  "provenance/agentic-plan-sources.json",
  "provenance/node-output-agentic.json",
  "provenance/conversation-foundation.json",
  "provenance/prompt-attachments.json",
  "provenance/reasoning-tools.json",
  "provenance/plans-tasks-queues.json",
  "provenance/approvals-checkpoints.json",
  "provenance/sources-citations.json",
  "provenance/agent-identity-context.json",
  "provenance/coding-artifacts.json",
  "provenance/sandbox-previews.json",
  "provenance/workflow-canvas.json",
];
const SHADCN_PROVENANCE_TRIGGERS = new Map([
  ["provenance/chat-foundation.json", "packages/ui/src/chat/MessageScroller.tsx"],
  ["provenance/agentic-reasoning-tool.json", "packages/ui/src/agentic/Reasoning.tsx"],
  ["provenance/agentic-response-code.json", "packages/ui/src/agentic/MessageResponse.tsx"],
  ["provenance/agentic-plan-sources.json", "packages/ui/src/agentic/Plan.tsx"],
  ["provenance/node-output-agentic.json", "packages/ui/src/agentic/AgentOutput.tsx"],
  ["provenance/conversation-foundation.json", "packages/ui/src/chat/Message.tsx"],
  ["provenance/prompt-attachments.json", "packages/ui/src/prompt/PromptInput.tsx"],
  ["provenance/reasoning-tools.json", "packages/ui/src/agentic/ToolCall.tsx"],
  ["provenance/plans-tasks-queues.json", "packages/ui/src/agentic/Queue.tsx"],
  ["provenance/approvals-checkpoints.json", "packages/ui/src/approvals/Confirmation.tsx"],
  ["provenance/sources-citations.json", "packages/ui/src/agentic/Suggestion.tsx"],
  ["provenance/agent-identity-context.json", "packages/ui/src/agents/AgentCard.tsx"],
  ["provenance/coding-artifacts.json", "packages/ui/src/artifacts/Artifact.tsx"],
  ["provenance/sandbox-previews.json", "packages/ui/src/sandbox/AgentSandbox.tsx"],
  ["provenance/workflow-canvas.json", "packages/ui/src/canvas/WorkflowCanvas.tsx"],
]);
const SHADCN_PROVENANCE_REQUIRED_FILES = new Map([
  ["provenance/chat-foundation.json", ["src/uiCss.ts"]],
  ["provenance/agentic-reasoning-tool.json", []],
  ["provenance/agentic-response-code.json", []],
  ["provenance/agentic-plan-sources.json", []],
  ["provenance/node-output-agentic.json", []],
  [
    "provenance/conversation-foundation.json",
    [
      "src/chat/MessageScroller.tsx",
      "src/chat/Message.tsx",
      "src/chat/MessageBranch.tsx",
      "src/chat/Bubble.tsx",
      "src/chat/CompactGroup.tsx",
      "src/chat/ConversationCheckpoint.tsx",
      "src/chat/Marker.tsx",
      "src/chat/Shimmer.tsx",
    ],
  ],
  ["provenance/prompt-attachments.json", ["src/prompt/PromptInput.tsx", "src/chat/Attachment.tsx"]],
  [
    "provenance/reasoning-tools.json",
    [
      "src/agentic/Reasoning.tsx",
      "src/agentic/ChainOfThought.tsx",
      "src/agentic/ToolCall.tsx",
      "src/agentic/MessageResponse.tsx",
      "src/agentic/AgentOutput.tsx",
      "src/agentic/CodeBlock.tsx",
    ],
  ],
  [
    "provenance/plans-tasks-queues.json",
    [
      "src/agentic/Plan.tsx",
      "src/agentic/TaskItem.tsx",
      "src/agentic/AgentTask.tsx",
      "src/agentic/Queue.tsx",
      "src/agentic/ActivityTimeline.tsx",
    ],
  ],
  [
    "provenance/approvals-checkpoints.json",
    ["src/approvals/Confirmation.tsx", "src/approvals/ApprovalCard.tsx", "src/approvals/Checkpoint.tsx"],
  ],
  [
    "provenance/sources-citations.json",
    [
      "src/agentic/Sources.tsx",
      "src/agentic/InlineCitation.tsx",
      "src/agentic/Suggestion.tsx",
      "src/agentic/OpenInChat.tsx",
    ],
  ],
  [
    "provenance/agent-identity-context.json",
    [
      "src/agents/AgentDefinition.tsx",
      "src/agents/AgentCard.tsx",
      "src/agents/ModelSelector.tsx",
      "src/agents/badges.tsx",
      "src/agents/ContextUsage.tsx",
    ],
  ],
  [
    "provenance/coding-artifacts.json",
    [
      "src/artifacts/Artifact.tsx",
      "src/artifacts/Snippet.tsx",
      "src/artifacts/PackageInfo.tsx",
      "src/artifacts/SchemaDisplay.tsx",
      "src/artifacts/StackTrace.tsx",
      "src/artifacts/TestResults.tsx",
      "src/artifacts/Commit.tsx",
      "src/artifacts/ChangeSummary.tsx",
      "src/artifacts/EnvironmentVariables.tsx",
      "src/artifacts/SecretField.tsx",
    ],
  ],
  [
    "provenance/sandbox-previews.json",
    ["src/sandbox/AgentSandbox.tsx", "src/sandbox/WebPreview.tsx", "src/sandbox/JSXPreview.tsx"],
  ],
  ["provenance/workflow-canvas.json", ["src/canvas/WorkflowCanvas.tsx", "src/canvas/canvasCss.ts"]],
]);
const SHADCN_PROVENANCE_COMPONENTS = new Map([
  ["src/chat/MessageScroller.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/Message.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/MessageBranch.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/Bubble.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/CompactGroup.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/ConversationCheckpoint.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/Marker.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/Shimmer.tsx", "provenance/conversation-foundation.json"],
  ["src/chat/Attachment.tsx", "provenance/prompt-attachments.json"],
  ["src/prompt/PromptInput.tsx", "provenance/prompt-attachments.json"],
  ["src/agentic/Reasoning.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/ChainOfThought.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/ToolCall.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/MessageResponse.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/AgentOutput.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/CodeBlock.tsx", "provenance/reasoning-tools.json"],
  ["src/agentic/Plan.tsx", "provenance/plans-tasks-queues.json"],
  ["src/agentic/TaskItem.tsx", "provenance/plans-tasks-queues.json"],
  ["src/agentic/AgentTask.tsx", "provenance/plans-tasks-queues.json"],
  ["src/agentic/Queue.tsx", "provenance/plans-tasks-queues.json"],
  ["src/agentic/ActivityTimeline.tsx", "provenance/plans-tasks-queues.json"],
  ["src/approvals/Confirmation.tsx", "provenance/approvals-checkpoints.json"],
  ["src/approvals/ApprovalCard.tsx", "provenance/approvals-checkpoints.json"],
  ["src/approvals/Checkpoint.tsx", "provenance/approvals-checkpoints.json"],
  ["src/agentic/Sources.tsx", "provenance/sources-citations.json"],
  ["src/agentic/InlineCitation.tsx", "provenance/sources-citations.json"],
  ["src/agentic/Suggestion.tsx", "provenance/sources-citations.json"],
  ["src/agentic/OpenInChat.tsx", "provenance/sources-citations.json"],
  ["src/agents/AgentDefinition.tsx", "provenance/agent-identity-context.json"],
  ["src/agents/AgentCard.tsx", "provenance/agent-identity-context.json"],
  ["src/agents/ModelSelector.tsx", "provenance/agent-identity-context.json"],
  ["src/agents/badges.tsx", "provenance/agent-identity-context.json"],
  ["src/agents/ContextUsage.tsx", "provenance/agent-identity-context.json"],
  ["src/artifacts/Artifact.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/Snippet.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/PackageInfo.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/SchemaDisplay.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/StackTrace.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/TestResults.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/Commit.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/ChangeSummary.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/EnvironmentVariables.tsx", "provenance/coding-artifacts.json"],
  ["src/artifacts/SecretField.tsx", "provenance/coding-artifacts.json"],
  ["src/sandbox/AgentSandbox.tsx", "provenance/sandbox-previews.json"],
  ["src/sandbox/WebPreview.tsx", "provenance/sandbox-previews.json"],
  ["src/sandbox/JSXPreview.tsx", "provenance/sandbox-previews.json"],
  ["src/canvas/WorkflowCanvas.tsx", "provenance/workflow-canvas.json"],
]);
const SHADCN_PROVENANCE_ENTRY_KEYS = [
  "collection",
  "divergences",
  "exports",
  "file",
  "omissions",
  "ported",
  "registryItem",
];
const SHADCN_PROVENANCE_VERIFICATION =
  "Each source file in an approved collection must name its upstream registry item URL in a lane manifest under provenance/. Entries record ported anatomy plus explicit omissions and divergences; this is provenance, not cryptographic verification.";
const PACK_UI_DIRECTORIES = [".smithers/ui", "examples/ui"];
// The built-in pack's older dark workflow UIs share one compatibility sheet
// that composes the canonical gateway theme and preserves their legacy token
// aliases. Keep this exception exact so new bespoke theme modules still fail.
const SANCTIONED_PACK_UI_THEME_MODULES = new Set([".smithers/ui/shared-theme.ts"]);
const PACK_UI_IMPORTS = new Set(["react", "smthrs/gateway-react", "smthrs/gateway-ui", "smthrs/ui"]);
const INTRINSIC_VISUAL_TAGS = new Set([
  "a",
  "article",
  "aside",
  "button",
  "canvas",
  "code",
  "div",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "header",
  "iframe",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "span",
  "strong",
  "svg",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "thead",
  "tr",
  "ul",
]);
function toPosix(value) {
  return value.split("\\").join("/");
}

function sorted(values) {
  return [...new Set(values)].sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function walk(root, start, predicate = () => true) {
  const absoluteStart = join(root, start);
  if (!existsSync(absoluteStart)) return [];
  const files = [];
  function visit(absoluteDirectory) {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(absoluteDirectory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = toPosix(relative(root, join(absoluteDirectory, entry.name)));
      if (predicate(path)) files.push(path);
    }
  }
  visit(absoluteStart);
  return files.sort(compareText);
}

/**
 * Runtime-generated pack artifacts are deliberately git-ignored (including via
 * .git/info/exclude), so they are not part of the governed surface. Outside a
 * git checkout (e.g. an exported archive) every file is kept.
 */
function gitIgnoredSet(root, paths) {
  if (paths.length === 0) return new Set();
  try {
    const stdout = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (error) {
    // git check-ignore exits 1 when nothing is ignored; treat any failure the same way.
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    return new Set(stdout.split("\0").filter(Boolean));
  }
}

function directWorkspaceDirectories(root, parent) {
  const absoluteParent = join(root, parent);
  if (!existsSync(absoluteParent)) return [];
  return readdirSync(absoluteParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(absoluteParent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}`)
    .sort(compareText);
}

function isSourcePath(path) {
  return (
    SOURCE_EXTENSIONS.has(extname(path)) && !path.endsWith(".d.ts") && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

function sourceFiles(root, kind) {
  if (kind === "multi") {
    return sorted([
      ...walk(root, "src", isSourcePath),
      ...directWorkspaceDirectories(root, "packages").flatMap((directory) =>
        walk(root, `${directory}/src`, isSourcePath),
      ),
    ]);
  }
  const packUiFiles = PACK_UI_DIRECTORIES.flatMap((directory) => walk(root, directory, isSourcePath));
  const ignoredPackUiFiles = gitIgnoredSet(root, packUiFiles);
  return sorted(
    ["packages", "apps"]
      .flatMap((parent) =>
        directWorkspaceDirectories(root, parent).flatMap((directory) => walk(root, directory, isSourcePath)),
      )
      .concat(packUiFiles.filter((path) => !ignoredPackUiFiles.has(path))),
  );
}

function styleFiles(root, kind) {
  const roots = kind === "multi" ? ["src", "packages"] : ["packages", "apps", ...PACK_UI_DIRECTORIES];
  const files = sorted(
    roots.flatMap((directory) => walk(root, directory, (path) => STYLE_EXTENSIONS.has(extname(path)))),
  );
  const ignoredPackUiFiles = gitIgnoredSet(root, files.filter(isPackUiPath));
  return files.filter((path) => !ignoredPackUiFiles.has(path));
}

function isPackUiPath(path) {
  return PACK_UI_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));
}

function isPackLocalImport(path, specifier) {
  if (!specifier.startsWith(".")) return false;
  const root = PACK_UI_DIRECTORIES.find((directory) => path.startsWith(`${directory}/`));
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  const helperRoot = root === ".smithers/ui" ? ".smithers/lib" : root === "examples/ui" ? "examples/lib" : undefined;
  return Boolean(
    root &&
    (target === root ||
      target.startsWith(`${root}/`) ||
      (helperRoot && (target === helperRoot || target.startsWith(`${helperRoot}/`)))),
  );
}

function isAllowedPackUiImport(path, specifier) {
  return (
    isPackLocalImport(path, specifier) || PACK_UI_IMPORTS.has(specifier) || specifier.startsWith("smthrs/ui/adapters/")
  );
}

function packUiViolations(path, source) {
  if (!isPackUiPath(path)) return [];
  const violations = [];
  for (const specifier of parseModuleSpecifiers(source)) {
    if (!isAllowedPackUiImport(path, specifier)) {
      violations.push(formatViolation("pack-ui-imports", `${path} imports ${specifier}`));
    }
  }
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hasStyleTag = false;
  let hasStyleProp = false;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sourceFile).toLowerCase() === "style") hasStyleTag = true;
      if (
        node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "style")
      ) {
        hasStyleProp = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (hasStyleTag) violations.push(formatViolation("pack-ui-style-tag", `${path} renders <style>`));
  if (hasStyleProp) violations.push(formatViolation("pack-ui-style-prop", `${path} renders a style prop`));
  const modulePath = path
    .replace(/\.[^.]+$/, "")
    .split("/")
    .filter((segment) => segment !== ".smithers" && segment !== "ui" && segment !== "examples");
  if (modulePath.some((segment) => /(?:theme|tokens?)/i.test(segment)) && !SANCTIONED_PACK_UI_THEME_MODULES.has(path)) {
    violations.push(formatViolation("pack-ui-theme-module", `${path} is a bespoke theme or token module`));
  }
  return violations;
}

function manifestFiles(root, kind) {
  const paths = existsSync(join(root, "package.json")) ? ["package.json"] : [];
  for (const parent of kind === "multi" ? ["packages"] : ["packages", "apps"]) {
    for (const directory of directWorkspaceDirectories(root, parent)) {
      paths.push(`${directory}/package.json`);
    }
  }
  return sorted(paths);
}

function lexModules(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      tokens.push({ kind: "template", value: "" });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let value = character;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$-]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function parseModuleReferences(source) {
  const tokens = lexModules(source);
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") continue;
    if ((token.value === "import" || token.value === "require") && tokens[index + 1]?.value === "(") {
      if (tokens[index + 2]?.kind === "string")
        references.push({ specifier: tokens[index + 2].value, typeOnly: false });
      continue;
    }
    if (token.value === "import" && tokens[index + 1]?.kind === "string") {
      references.push({ specifier: tokens[index + 1].value, typeOnly: false });
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 80); cursor += 1) {
      if (tokens[cursor].value === ";") break;
      if (tokens[cursor].value === "from" && tokens[cursor + 1]?.kind === "string") {
        references.push({
          specifier: tokens[cursor + 1].value,
          typeOnly: tokens[index + 1]?.value === "type",
        });
        break;
      }
    }
  }
  return references;
}

export function parseModuleSpecifiers(source) {
  return sorted(parseModuleReferences(source).map(({ specifier }) => specifier));
}

function basePackage(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  if (specifier.startsWith("smthrs/")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function matchesPrefix(value, prefixes) {
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? value.startsWith(prefix) : value === prefix || value.startsWith(`${prefix}/`),
  );
}

function isUiSpecifier(specifier) {
  return UI_PACKAGES.has(basePackage(specifier));
}

function isGatewayReact(specifier) {
  const base = basePackage(specifier);
  return base === "@smthrs/gateway-react" || base === "smthrs/gateway-react";
}

function isSmithersPackage(specifier) {
  return specifier === "smthrs" || specifier.startsWith("smthrs/") || specifier.startsWith("@smthrs/");
}

function isLegacyUiPackage(specifier) {
  return LEGACY_UI_PACKAGES.has(basePackage(specifier));
}

function isHeavyDependency(specifier) {
  return matchesPrefix(specifier, HEAVY_DEPENDENCY_PREFIXES);
}

function isDuplicateWrapperOrIcon(path) {
  const withoutExtension = posix.basename(path, extname(path)).toLowerCase();
  const looksVisual =
    path.endsWith(".jsx") || path.endsWith(".tsx") || /\/(cards?|components?|icons?|ui|views?)\//i.test(path);
  return (
    looksVisual &&
    (DUPLICATE_WRAPPER_NAMES.has(withoutExtension) ||
      withoutExtension === "icon" ||
      withoutExtension === "icons" ||
      withoutExtension.endsWith("-icon") ||
      withoutExtension.endsWith("icon") ||
      path.toLowerCase().includes("/icons/"))
  );
}

function isStyleModule(path) {
  const name = posix.basename(path, extname(path));
  return ["css", "style", "styles", "styleguide-css", "theme", "themes", "tokens", "uiCss"].includes(name);
}

function hasCodeIdentifier(source, identifiers) {
  return lexModules(source).some((token) => token.kind === "identifier" && identifiers.has(token.value));
}

function intrinsicVisualTags(source, path) {
  const tokens = lexModules(source);
  const tags = [];
  if (path.endsWith(".jsx") || path.endsWith(".tsx")) {
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (
        tokens[index].value === "<" &&
        tokens[index + 1].kind === "identifier" &&
        INTRINSIC_VISUAL_TAGS.has(tokens[index + 1].value)
      ) {
        tags.push(tokens[index + 1].value);
      }
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const createsElement =
      tokens[index].value === "React" &&
      tokens[index + 1].value === "." &&
      tokens[index + 2].value === "createElement" &&
      tokens[index + 3].value === "(";
    const jsxRuntime = ["jsx", "jsxs"].includes(tokens[index].value) && tokens[index + 1].value === "(";
    const candidate = createsElement ? tokens[index + 4] : jsxRuntime ? tokens[index + 2] : null;
    if (candidate?.kind === "string" && INTRINSIC_VISUAL_TAGS.has(candidate.value)) tags.push(candidate.value);
  }
  return sorted(tags);
}

function cssInJsVisualTags(source, path) {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tags = [];
  const templateText = (template) => {
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
    return [template.head.text, ...template.templateSpans.map((span) => span.literal.text)].join(" ");
  };
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const css = templateText(node.template);
      const hasCssDeclaration = /(?:^|[;{\s])(?:--[\w-]+|[a-z][\w-]*)\s*:\s*[^;\n}]+(?:[;}]|$)/i.test(css);
      if (hasCssDeclaration) tags.push(node.tag.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sorted(tags);
}

function formatViolation(rule, detail) {
  return `${rule} :: ${detail}`;
}

function exportEntries(path, manifest) {
  const entries = typeof manifest.name === "string" ? [`${path}#name=${JSON.stringify(manifest.name)}`] : [];
  entries.push(
    ...(manifest.exports && typeof manifest.exports === "object"
      ? Object.entries(manifest.exports)
          .sort(([left], [right]) => compareText(left, right))
          .map(([key, value]) => `${path}#${key}=${JSON.stringify(stableValue(value))}`)
      : []),
  );
  for (const key of ["browser", "main", "module"]) {
    if (typeof manifest[key] === "string") entries.push(`${path}#${key}=${JSON.stringify(manifest[key])}`);
  }
  return sorted(entries);
}

function stringLeaves(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicEntryPaths(root, manifestPath, manifest, files) {
  const directory = posix.dirname(manifestPath);
  const conventionalEntries = ["./index.js", "./index.jsx", "./index.ts", "./index.tsx"];
  const targets = [
    ...stringLeaves(manifest.exports),
    ...[manifest.main, manifest.module, manifest.browser].filter((value) => typeof value === "string"),
    ...(manifest.exports?.["."] || manifest.main || manifest.module || manifest.browser ? [] : conventionalEntries),
  ];
  return sorted(
    targets
      .filter((target) => !posix.isAbsolute(target) && !target.includes(":"))
      .flatMap((target) => {
        const normalized = posix.normalize(posix.join(directory, target));
        if (!normalized.includes("*")) return existsSync(join(root, normalized)) ? [normalized] : [];
        const pattern = new RegExp(`^${normalized.split("*").map(escapeRegExp).join(".*")}$`);
        return files.filter((path) => pattern.test(path));
      })
      .filter((target) => !target.endsWith(".d.ts")),
  );
}

function jsxComponentSpecifiers(source) {
  const tokens = lexModules(source);
  const jsxRoots = new Set();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      tokens[index].value === "<" &&
      tokens[index + 1].kind === "identifier" &&
      /^[A-Z]/.test(tokens[index + 1].value)
    ) {
      jsxRoots.add(tokens[index + 1].value);
    }
  }
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "import") continue;
    const bindings = new Set();
    let specifier = null;
    for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 80); cursor += 1) {
      if (tokens[cursor].value === ";") break;
      if (tokens[cursor].value === "from" && tokens[cursor + 1]?.kind === "string") {
        specifier = tokens[cursor + 1].value;
        break;
      }
      if (tokens[cursor].kind === "identifier" && /^[A-Z]/.test(tokens[cursor].value))
        bindings.add(tokens[cursor].value);
    }
    if (specifier && [...bindings].some((binding) => jsxRoots.has(binding))) specifiers.push(specifier);
  }
  return sorted(specifiers);
}

function staticPropertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
  return null;
}

function isModuleExports(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function commonJsExportName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "exports") return node.name.text;
    if (isModuleExports(node.expression)) return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "exports") return node.argumentExpression.text;
    if (isModuleExports(node.expression)) return node.argumentExpression.text;
  }
  return null;
}

function sourceFile(source, path) {
  const extension = extname(path);
  const scriptKind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : [".js", ".mjs", ".cjs"].includes(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function hasPublicHookExport(source, path, exportMode = "all") {
  const file = sourceFile(source, path);
  const includesNamedExports = exportMode !== "default";
  const includesDefaultExport = exportMode !== "named";
  const isHookName = (name) => /^use[A-Z]/.test(name ?? "");
  const hasExportModifier = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const hasDefaultModifier = (node) =>
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
  const moduleName = posix.basename(path, extname(path));
  const hookModuleName = moduleName === "index" ? posix.basename(posix.dirname(path)) : moduleName;
  const isHookModule = /^use(?:[-_A-Z]|$)/.test(hookModuleName);
  const bindingExportsHook = (name) => {
    if (ts.isIdentifier(name)) return isHookName(name.text);
    return name.elements.some((element) => ts.isBindingElement(element) && bindingExportsHook(element.name));
  };
  let hasRuntimeDefaultExport = false;

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause) {
      if (
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => {
          if (element.isTypeOnly) return false;
          const exportedName = element.name.text;
          const localName = (element.propertyName ?? element.name).text;
          if (exportedName === "default") {
            if (!includesDefaultExport) return false;
            hasRuntimeDefaultExport = true;
            return isHookName(localName);
          }
          return includesNamedExports && isHookName(exportedName);
        })
      ) {
        return true;
      }
      if (
        includesNamedExports &&
        ts.isNamespaceExport(statement.exportClause) &&
        isHookName(statement.exportClause.name.text)
      ) {
        return true;
      }
    }
    if (hasExportModifier(statement)) {
      const isDefaultExport = hasDefaultModifier(statement);
      const isTypeOnlyDeclaration = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
      if (isDefaultExport && includesDefaultExport && !isTypeOnlyDeclaration) {
        hasRuntimeDefaultExport = true;
      }
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        ((isDefaultExport && includesDefaultExport) || (!isDefaultExport && includesNamedExports)) &&
        isHookName(statement.name?.text)
      ) {
        return true;
      }
      if (
        includesNamedExports &&
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((declaration) => bindingExportsHook(declaration.name))
      ) {
        return true;
      }
    }
    if (ts.isExportAssignment(statement) && includesDefaultExport) {
      hasRuntimeDefaultExport = true;
      if (ts.isIdentifier(statement.expression) && isHookName(statement.expression.text)) return true;
    }
  }
  if (includesDefaultExport && hasRuntimeDefaultExport && isHookModule) return true;

  let commonJsHookFound = false;
  let commonJsDefaultExportFound = false;
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (includesNamedExports && isHookName(commonJsExportName(node.left))) {
        commonJsHookFound = true;
        return;
      }
      if (includesDefaultExport && isModuleExports(node.left)) {
        commonJsDefaultExportFound = true;
        if (ts.isIdentifier(node.right) && isHookName(node.right.text)) {
          commonJsHookFound = true;
          return;
        }
      }
      if (
        includesNamedExports &&
        isModuleExports(node.left) &&
        ts.isObjectLiteralExpression(node.right) &&
        node.right.properties.some((property) => isHookName(staticPropertyName(property.name)))
      ) {
        commonJsHookFound = true;
        return;
      }
    }
    if (
      includesNamedExports &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2 &&
      ((ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === "exports") ||
        isModuleExports(node.arguments[0])) &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      isHookName(node.arguments[1].text)
    ) {
      commonJsHookFound = true;
      return;
    }
    if (!commonJsHookFound) ts.forEachChild(node, visit);
  };
  visit(file);
  return commonJsHookFound || (includesDefaultExport && commonJsDefaultExportFound && isHookModule);
}

function relativeHookReexports(source, path) {
  const file = sourceFile(source, path);
  const reexports = [];
  for (const statement of file.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    if (!statement.exportClause) {
      reexports.push({ exportedMode: "named", targetMode: "named", specifier: statement.moduleSpecifier.text });
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      reexports.push({ exportedMode: "named", targetMode: "all", specifier: statement.moduleSpecifier.text });
      continue;
    }
    if (
      statement.exportClause.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === "default" &&
          (element.propertyName ?? element.name).text === "default",
      )
    ) {
      reexports.push({ exportedMode: "default", targetMode: "default", specifier: statement.moduleSpecifier.text });
    }
  }
  return reexports;
}

function publicEntryExportsHook(entryPath, files, sources) {
  const pending = [{ mode: "all", path: entryPath }];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { mode, path } = current;
    const visitKey = `${mode}:${path}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const source = sources.get(path);
    if (source === undefined) continue;
    if (hasPublicHookExport(source, path, mode)) return true;
    for (const reexport of relativeHookReexports(source, path)) {
      if (mode !== "all" && reexport.exportedMode !== mode) continue;
      const target = resolveRelativeSource(path, reexport.specifier, files);
      if (target) pending.push({ mode: reexport.targetMode, path: target });
    }
  }
  return false;
}

function uiLayer(path) {
  const prefix = "packages/ui/src/";
  if (!path.startsWith(prefix)) return null;
  const relativePath = path.slice(prefix.length);
  if (relativePath.startsWith("smithers/connected/")) return "connected";
  const layer = relativePath.split("/")[0];
  return [
    "adapters",
    "agentic",
    "agents",
    "ai",
    "approvals",
    "artifacts",
    "calendar",
    "canvas",
    "chat",
    "internal",
    "primitives",
    "prompt",
    "sandbox",
    "smithers",
    "styles",
    "time",
    "vault",
  ].includes(layer)
    ? layer
    : null;
}

function importedUiLayer(file, specifier) {
  if (isGatewayReact(specifier)) return "gateway-react";
  const uiBases = ["@smthrs/ui/", "smthrs/ui/"];
  const externalBase = uiBases.find((base) => specifier.startsWith(base));
  if (externalBase) {
    const subpath = specifier.slice(externalBase.length);
    return subpath.startsWith("smithers/connected") ? "connected" : subpath.split("/")[0];
  }
  if (!specifier.startsWith(".")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
  return uiLayer(resolved);
}

function resolveRelativeSource(file, specifier, files) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(file), specifier));
  const extension = extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  const candidates = [
    ...new Set([
      base,
      ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((candidateExtension) => `${stem}${candidateExtension}`),
      ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${base}/index${extension}`),
    ]),
  ];
  return candidates.find((candidate) => files.includes(candidate)) ?? null;
}

function disconnectedPropViolations(path, source) {
  const layer = uiLayer(path);
  if (!["agentic", "ai", "canvas", "chat", "primitives", "smithers"].includes(layer)) return [];
  if (path.includes("/smithers/connected/") || posix.basename(path).startsWith("index.")) return [];
  if (!source.includes("<") || !/[.]tsx?$/.test(path)) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hasModifier = (node, kind) => node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
  const containsJsx = (node) => {
    let found = false;
    const visit = (child) => {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const componentFunction = (expression) => {
    if (!expression) return null;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return componentFunction(expression.expression);
    }
    if (ts.isCallExpression(expression)) {
      return expression.arguments.map(componentFunction).find(Boolean) ?? null;
    }
    return null;
  };
  const exported = new Set();
  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      !statement.moduleSpecifier
    ) {
      for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression))
      exported.add(statement.expression.text);
  }
  const violations = [];
  const inspectFunction = (name, fn, contextualType = null, wrapper = null) => {
    if (!fn || !containsJsx(fn) || fn.parameters.length === 0) return;
    const wrapperTypes = wrapper && ts.isCallExpression(wrapper) ? (wrapper.typeArguments?.length ?? 0) : 0;
    if (!fn.parameters[0].type && !contextualType && wrapperTypes === 0) violations.push(name);
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword) || exported.has(name);
      if (isExported && (name === "default" || /^[A-Z]/.test(name))) inspectFunction(name, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const statementExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !/^[A-Z]/.test(declaration.name.text)) continue;
        if (!statementExported && !exported.has(declaration.name.text)) continue;
        inspectFunction(
          declaration.name.text,
          componentFunction(declaration.initializer),
          declaration.type,
          declaration.initializer,
        );
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !ts.isIdentifier(statement.expression)) {
      inspectFunction("default", componentFunction(statement.expression), null, statement.expression);
    }
  }
  return sorted(violations);
}

function shadcnViolations(root, files) {
  const violations = [];
  const manifestPath = "packages/ui/shadcn-provenance.json";
  if (!existsSync(join(root, manifestPath))) {
    return [formatViolation("shadcn-provenance", `${manifestPath} is missing`)];
  }
  let manifest;
  try {
    manifest = readJson(join(root, manifestPath));
  } catch (error) {
    return [formatViolation("shadcn-provenance", `${manifestPath} is invalid JSON: ${error.message}`)];
  }
  if (manifest.$schema !== SHADCN_PROVENANCE_SCHEMA) {
    violations.push(formatViolation("shadcn-provenance", `\$schema must be ${SHADCN_PROVENANCE_SCHEMA}`));
  }
  if (manifest.version !== 2) {
    violations.push(formatViolation("shadcn-provenance", "version must be 2"));
  }
  if (JSON.stringify(manifest.policy?.registries) !== JSON.stringify(SHADCN_PROVENANCE_REGISTRIES)) {
    violations.push(
      formatViolation(
        "shadcn-provenance",
        `policy.registries must equal ${JSON.stringify(SHADCN_PROVENANCE_REGISTRIES)}`,
      ),
    );
  }
  if (JSON.stringify(manifest.policy?.collections) !== JSON.stringify(SHADCN_PROVENANCE_COLLECTIONS)) {
    violations.push(
      formatViolation(
        "shadcn-provenance",
        `policy.collections must equal ${JSON.stringify(SHADCN_PROVENANCE_COLLECTIONS)}`,
      ),
    );
  }
  if (manifest.policy?.verification !== SHADCN_PROVENANCE_VERIFICATION) {
    violations.push(
      formatViolation("shadcn-provenance", "policy.verification does not match the frozen provenance policy"),
    );
  }
  if (JSON.stringify(manifest.policy?.entryFiles) !== JSON.stringify(SHADCN_PROVENANCE_ENTRY_FILES)) {
    violations.push(
      formatViolation(
        "shadcn-provenance",
        `policy.entryFiles must equal ${JSON.stringify(SHADCN_PROVENANCE_ENTRY_FILES)}`,
      ),
    );
  }
  if (!Array.isArray(manifest.entries)) {
    violations.push(
      formatViolation("shadcn-provenance", "entries must be an array aggregating the provenance/ fragments"),
    );
  }

  const recordedPaths = new Set();
  const recordedManifests = new Map();
  const fileSet = new Set(files);
  const aggregatedEntries = [];
  const aggregatedByFile = new Map();
  for (const entryFile of SHADCN_PROVENANCE_ENTRY_FILES) {
    const laneManifestPath = `packages/ui/${entryFile}`;
    const laneManifestAbsolutePath = join(root, laneManifestPath);
    const triggerPath = SHADCN_PROVENANCE_TRIGGERS.get(entryFile);
    if (!existsSync(laneManifestAbsolutePath)) {
      if (triggerPath && fileSet.has(triggerPath)) {
        violations.push(formatViolation("shadcn-provenance", `${laneManifestPath} is missing`));
      }
      continue;
    }

    let laneEntries;
    try {
      laneEntries = readJson(laneManifestAbsolutePath);
    } catch (error) {
      violations.push(formatViolation("shadcn-provenance", `${laneManifestPath} is invalid JSON: ${error.message}`));
      continue;
    }
    if (!Array.isArray(laneEntries)) {
      violations.push(formatViolation("shadcn-provenance", `${laneManifestPath} must contain an array`));
      continue;
    }

    const laneRecordedPaths = new Set();
    for (const entry of laneEntries) {
      const entryPath = typeof entry?.file === "string" ? toPosix(entry.file) : "";
      const fullPath = entryPath ? `packages/ui/${entryPath}` : "";
      if (JSON.stringify(Object.keys(entry ?? {}).sort()) !== JSON.stringify(SHADCN_PROVENANCE_ENTRY_KEYS)) {
        violations.push(
          formatViolation("shadcn-provenance", `${entryPath || laneManifestPath} does not use the frozen entry shape`),
        );
      }
      if (!entryPath || entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
        violations.push(formatViolation("shadcn-provenance", `${laneManifestPath} has an invalid or missing file`));
      } else if (recordedPaths.has(fullPath)) {
        violations.push(formatViolation("shadcn-provenance", `${fullPath} has duplicate provenance entries`));
      } else {
        recordedPaths.add(fullPath);
        recordedManifests.set(entryPath, entryFile);
        laneRecordedPaths.add(entryPath);
        aggregatedByFile.set(entryPath, entry);
        if (!fileSet.has(fullPath)) {
          violations.push(formatViolation("shadcn-provenance", `${fullPath} is a stale provenance entry`));
        }
      }

      if (
        !Array.isArray(entry?.exports) ||
        entry.exports.length === 0 ||
        entry.exports.some((value) => typeof value !== "string" || !value)
      ) {
        violations.push(
          formatViolation(
            "shadcn-provenance",
            `${entryPath || laneManifestPath} exports must be a non-empty string array`,
          ),
        );
      }
      if (!SHADCN_PROVENANCE_COLLECTIONS.includes(entry?.collection)) {
        violations.push(
          formatViolation("shadcn-provenance", `${entryPath || laneManifestPath} has an unapproved collection`),
        );
      }
      if (entry?.ported !== "partial-anatomy" && entry?.ported !== "full-anatomy") {
        violations.push(
          formatViolation(
            "shadcn-provenance",
            `${entryPath || laneManifestPath} ported must be partial-anatomy or full-anatomy`,
          ),
        );
      }
      for (const field of ["omissions", "divergences"]) {
        if (!Array.isArray(entry?.[field]) || entry[field].some((value) => typeof value !== "string")) {
          violations.push(
            formatViolation("shadcn-provenance", `${entryPath || laneManifestPath} ${field} must be a string array`),
          );
        }
      }

      try {
        if (entry?.registryItem === null) {
          // Smithers-native component with no upstream registry item.
        } else {
          const registryItem = new URL(entry?.registryItem);
          const expectedOrigin =
            entry?.collection === "agentic/ai-elements" ? "https://elements.ai-sdk.dev" : "https://ui.shadcn.com";
          const approvedPath =
            expectedOrigin === "https://elements.ai-sdk.dev"
              ? registryItem.pathname.startsWith("/components/")
              : registryItem.pathname.startsWith("/docs/components/base/") ||
                registryItem.pathname.startsWith("/docs/utils/") ||
                registryItem.pathname.startsWith("/r/");
          if (
            registryItem.origin !== expectedOrigin ||
            registryItem.username ||
            registryItem.password ||
            !approvedPath ||
            registryItem.search ||
            registryItem.hash
          ) {
            throw new Error("not an approved registry item URL");
          }
        }
      } catch {
        violations.push(
          formatViolation(
            "shadcn-provenance",
            `${entryPath || laneManifestPath} registryItem must be an exact approved registry URL`,
          ),
        );
      }
    }

    if (triggerPath && fileSet.has(triggerPath)) {
      for (const requiredFile of SHADCN_PROVENANCE_REQUIRED_FILES.get(entryFile) ?? []) {
        if (!laneRecordedPaths.has(requiredFile)) {
          violations.push(formatViolation("shadcn-provenance", `${laneManifestPath} has no entry for ${requiredFile}`));
        }
      }
    }
  }

  for (const entry of aggregatedByFile.values()) aggregatedEntries.push(entry);
  if (Array.isArray(manifest.entries) && JSON.stringify(manifest.entries) !== JSON.stringify(aggregatedEntries)) {
    violations.push(
      formatViolation(
        "shadcn-provenance",
        "entries must equal the aggregation of the provenance/ fragments (superseded entries removed)",
      ),
    );
  }

  const shadcnFiles = files.filter((path) => SHADCN_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`)));
  for (const path of shadcnFiles) {
    if (!recordedPaths.has(path))
      violations.push(formatViolation("shadcn-provenance", `${path} has no provenance entry`));
  }
  for (const [entryPath, expectedManifest] of SHADCN_PROVENANCE_COMPONENTS) {
    if (fileSet.has(`packages/ui/${entryPath}`) && recordedManifests.get(entryPath) !== expectedManifest) {
      violations.push(
        formatViolation(
          "shadcn-provenance",
          `packages/ui/${entryPath} has no entry in packages/ui/${expectedManifest}`,
        ),
      );
    }
  }
  return violations;
}

export function collectUiArchitectureState(root, kind = "smithers") {
  const absoluteRoot = resolve(root);
  const files = sourceFiles(absoluteRoot, kind);
  const styles = styleFiles(absoluteRoot, kind);
  const manifests = manifestFiles(absoluteRoot, kind);
  const imports = new Map();
  const references = new Map();
  const sources = new Map();
  for (const path of files) {
    const source = readFileSync(join(absoluteRoot, path), "utf8");
    sources.set(path, source);
    imports.set(path, parseModuleSpecifiers(source));
    references.set(path, parseModuleReferences(source));
  }

  const inventories = Object.fromEntries(INVENTORY_KEYS.map((key) => [key, []]));
  const violations = [];

  for (const [path, specifiers] of imports) {
    violations.push(...packUiViolations(path, sources.get(path)));
    for (const specifier of specifiers) {
      if (!isPackUiPath(path)) {
        // Sanctioned program files import ONLY the @smthrs/ui
        // barrel and the @smthrs/gateway-react data hooks
        // (integrationContract E); those edges are exempt from the frozen
        // uiImports inventory. Any other specifier still inventories.
        const sanctionedBarrelEdge =
          SANCTIONED_GATEWAY_UI_PROGRAM_FILES.has(path) && SANCTIONED_GATEWAY_UI_PROGRAM_SPECIFIERS.has(specifier);
        if (isUiSpecifier(specifier) && !sanctionedBarrelEdge) inventories.uiImports.push(`${path} -> ${specifier}`);
        if (isLegacyUiPackage(specifier)) inventories.legacyPackageUsage.push(`${path} -> ${specifier}`);
        if (STYLE_EXTENSIONS.has(extname(specifier))) inventories.styleEntryPoints.push(`${path} -> ${specifier}`);
      }
      if (matchesPrefix(specifier, FORBIDDEN_REGISTRY_PREFIXES)) {
        violations.push(formatViolation("official-shadcn-only", `${path} imports ${specifier}`));
      }
      if (kind === "smithers" && path.startsWith("packages/components/src/")) {
        if (
          isUiSpecifier(specifier) ||
          matchesPrefix(specifier, VISUAL_DEPENDENCY_PREFIXES) ||
          STYLE_EXTENSIONS.has(extname(specifier))
        ) {
          violations.push(formatViolation("components-non-visual", `${path} imports ${specifier}`));
        }
      }
      if (
        kind === "smithers" &&
        path.startsWith("packages/ui/src/") &&
        isHeavyDependency(specifier) &&
        !path.startsWith("packages/ui/src/adapters/")
      ) {
        violations.push(formatViolation("heavy-widget-location", `${path} imports ${specifier} outside adapters`));
      }
      if (
        kind === "smithers" &&
        !isPackUiPath(path) &&
        isGatewayReact(specifier) &&
        !SANCTIONED_GATEWAY_UI_PROGRAM_FILES.has(path) &&
        !path.startsWith("packages/ui/src/smithers/connected/")
      ) {
        violations.push(formatViolation("gateway-react-location", `${path} imports ${specifier}`));
      }
      if (kind === "smithers" && path.startsWith("packages/gateway-react/src/")) {
        if (
          isSmithersPackage(specifier) &&
          basePackage(specifier) !== "@smthrs/gateway-client" &&
          basePackage(specifier) !== "smthrs/gateway-client"
        ) {
          violations.push(formatViolation("gateway-react-direction", `${path} imports ${specifier}`));
        }
      }
      if (
        kind === "smithers" &&
        path.startsWith("packages/ui-core/src/") &&
        (matchesPrefix(specifier, UI_CORE_FORBIDDEN_PREFIXES) || UI_CORE_FORBIDDEN_PACKAGES.has(basePackage(specifier)))
      ) {
        violations.push(formatViolation("ui-core-boundary", `${path} imports ${specifier}`));
      }
      if (
        kind === "smithers" &&
        path.startsWith("packages/tui-ui/src/") &&
        TUI_UI_FORBIDDEN_PACKAGES.has(basePackage(specifier))
      ) {
        violations.push(formatViolation("tui-ui-boundary", `${path} imports ${specifier}`));
      }
    }

    if (kind === "smithers") {
      const layer = uiLayer(path);
      const allowedLayers = {
        adapters: new Set(["adapters", "internal", "primitives", "styles"]),
        agentic: new Set(["agentic", "chat", "internal", "primitives", "styles"]),
        agents: new Set(["agentic", "agents", "internal", "primitives", "styles"]),
        ai: new Set(["ai", "chat", "internal", "primitives", "styles"]),
        approvals: new Set(["agentic", "approvals", "internal", "primitives", "styles"]),
        artifacts: new Set(["agentic", "artifacts", "internal", "primitives", "styles"]),
        calendar: new Set(["calendar", "internal", "styles", "time"]),
        canvas: new Set(["canvas", "internal", "primitives", "styles"]),
        chat: new Set(["chat", "internal", "primitives", "styles"]),
        connected: new Set(["connected", "gateway-react", "internal", "smithers", "styles"]),
        internal: new Set(["internal"]),
        primitives: new Set(["internal", "primitives", "styles"]),
        prompt: new Set(["chat", "internal", "primitives", "prompt", "styles"]),
        sandbox: new Set(["internal", "primitives", "sandbox", "styles"]),
        smithers: new Set(["adapters", "agentic", "ai", "internal", "primitives", "smithers", "styles"]),
        styles: new Set(["internal", "styles"]),
        time: new Set(["internal", "styles", "time"]),
        vault: new Set(["internal", "styles", "time", "vault"]),
      };
      if (layer) {
        for (const specifier of specifiers) {
          const target = importedUiLayer(path, specifier);
          if (
            target &&
            !allowedLayers[layer].has(target) &&
            !SANCTIONED_UI_LAYER_EDGES.has(`${path} -> ${specifier}`)
          ) {
            violations.push(
              formatViolation("ui-layer-direction", `${path} (${layer}) imports ${specifier} (${target})`),
            );
          }
        }
        if (layer === "smithers") {
          for (const reference of references.get(path)) {
            if (importedUiLayer(path, reference.specifier) === "adapters" && !reference.typeOnly) {
              violations.push(
                formatViolation("adapter-types-only", `${path} imports ${reference.specifier} at runtime`),
              );
            }
          }
        }
      }
      for (const component of disconnectedPropViolations(path, sources.get(path))) {
        violations.push(formatViolation("disconnected-typed-props", `${path} exports ${component} with untyped props`));
      }
      if (path === "packages/ui/src/index.ts" || path === "packages/ui/src/index.tsx") {
        for (const specifier of specifiers) {
          if (
            specifier.includes("/adapters") ||
            specifier.includes("smithers/connected") ||
            isHeavyDependency(specifier)
          ) {
            violations.push(formatViolation("base-ui-export", `${path} exposes ${specifier}`));
          }
          const target = resolveRelativeSource(path, specifier, files);
          if (target && imports.get(target)?.some(isHeavyDependency)) {
            violations.push(formatViolation("base-ui-export", `${path} exposes heavy module ${target}`));
          }
        }
      }
      if (
        path.startsWith("packages/components/src/") &&
        hasCodeIdentifier(sources.get(path), new Set(["document", "window", "HTMLElement", "SVGElement"]))
      ) {
        violations.push(formatViolation("components-non-visual", `${path} references a browser DOM global`));
      }
      if (
        path.startsWith("packages/ui-core/src/") &&
        !path.startsWith(UI_CORE_WEB_ADAPTER_PREFIX) &&
        hasCodeIdentifier(sources.get(path), UI_CORE_DOM_GLOBALS)
      ) {
        violations.push(formatViolation("ui-core-boundary", `${path} references a browser DOM global`));
      }
      if (path.startsWith("packages/components/src/")) {
        for (const tag of intrinsicVisualTags(sources.get(path), path)) {
          violations.push(formatViolation("components-non-visual", `${path} renders intrinsic <${tag}>`));
        }
        for (const tag of cssInJsVisualTags(sources.get(path), path)) {
          violations.push(formatViolation("components-non-visual", `${path} declares CSS-in-JS with ${tag}`));
        }
      }
      if (
        path.startsWith("packages/ui/src/") &&
        !uiLayer(path) &&
        !["packages/ui/src/index.ts", "packages/ui/src/index.tsx"].includes(path)
      ) {
        violations.push(formatViolation("ui-layer-placement", `${path} is outside the target UI layers`));
      }
      if (
        (path.startsWith("packages/gateway-ui/src/") ||
          (path.startsWith("packages/ui-styleguide/src/") &&
            !CANONICAL_STYLEGUIDE_FILES.has(path))) &&
        !SANCTIONED_GATEWAY_UI_PROGRAM_FILES.has(path)
      ) {
        violations.push(formatViolation("compatibility-facade-file", `${path} is legacy facade implementation`));
      }
    }
  }

  if (kind === "smithers") {
    for (const entry of ["packages/ui/src/index.ts", "packages/ui/src/index.tsx"].filter((path) =>
      files.includes(path),
    )) {
      const pending = [entry];
      const visited = new Set();
      while (pending.length) {
        const current = pending.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        for (const specifier of imports.get(current) ?? []) {
          if (isHeavyDependency(specifier)) {
            violations.push(
              formatViolation(
                "base-ui-export",
                `${entry} transitively exposes heavy dependency ${specifier} via ${current}`,
              ),
            );
          }
          const target = resolveRelativeSource(current, specifier, files);
          if (!target) continue;
          if (target.startsWith("packages/ui/src/adapters/")) {
            violations.push(
              formatViolation("base-ui-export", `${entry} transitively exposes adapter module ${target}`),
            );
          }
          pending.push(target);
        }
      }
    }
  }

  for (const path of files) {
    if (!isPackUiPath(path) && isStyleModule(path)) inventories.styleEntryPoints.push(path);
    const canonicalUi = kind === "smithers" && path.startsWith("packages/ui/src/");
    if (!isPackUiPath(path) && !canonicalUi && isDuplicateWrapperOrIcon(path))
      inventories.localDuplicateWrappersAndIcons.push(path);
  }
  inventories.styleEntryPoints.push(...styles);

  for (const path of manifests) {
    const manifest = readJson(join(absoluteRoot, path));
    const includeExports =
      kind === "multi" ||
      [
        "@smthrs/components",
        "@smthrs/gateway-react",
        "@smthrs/gateway-ui",
        "@smthrs/ui",
        "@smthrs/ui-styleguide",
        "smthrs",
      ].includes(manifest.name);
    if (typeof manifest.name === "string") {
      inventories.packageExportSurfaces.push(`${path}#name=${JSON.stringify(manifest.name)}`);
    }
    if (includeExports) inventories.packageExportSurfaces.push(...exportEntries(path, manifest));
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section] ?? {};
      for (const [dependency, version] of Object.entries(dependencies).sort(([left], [right]) =>
        compareText(left, right),
      )) {
        if (isHeavyDependency(dependency)) {
          inventories.heavyWidgetDependencies.push(`${path}#${section}:${dependency}@${version}`);
        }
        if (isLegacyUiPackage(dependency)) {
          inventories.legacyPackageUsage.push(`${path}#${section}:${dependency}@${version}`);
        }
        if (matchesPrefix(dependency, FORBIDDEN_REGISTRY_PREFIXES)) {
          violations.push(formatViolation("official-shadcn-only", `${path} ${section} contains ${dependency}`));
        }
        if (
          kind === "smithers" &&
          path === "packages/components/package.json" &&
          (isUiSpecifier(dependency) || matchesPrefix(dependency, VISUAL_DEPENDENCY_PREFIXES))
        ) {
          violations.push(formatViolation("components-non-visual", `${path} ${section} contains ${dependency}`));
        }
        if (
          kind === "smithers" &&
          path === "packages/gateway-react/package.json" &&
          section !== "devDependencies" &&
          isSmithersPackage(dependency) &&
          dependency !== "@smthrs/gateway-client"
        ) {
          violations.push(formatViolation("gateway-react-direction", `${path} ${section} contains ${dependency}`));
        }
        if (
          kind === "smithers" &&
          path.startsWith("packages/") &&
          !["@smthrs/gateway-ui", "@smthrs/ui", "@smthrs/ui-styleguide"].includes(manifest.name) &&
          matchesPrefix(dependency, VISUAL_DEPENDENCY_PREFIXES)
        ) {
          violations.push(formatViolation("single-visual-package", `${path} ${section} contains ${dependency}`));
        }
      }
    }
    const exportKeys = manifest.exports && typeof manifest.exports === "object" ? Object.keys(manifest.exports) : [];
    const permitsWorkflowRenderHooks = WORKFLOW_RENDER_HOOK_PACKAGES.has(manifest.name);
    if (
      kind === "smithers" &&
      manifest.name !== "@smthrs/gateway-react" &&
      !permitsWorkflowRenderHooks &&
      (/(^|[-/])hooks?$/.test(manifest.name ?? "") ||
        exportKeys.some((key) => /(^|\/)(?:hooks?|use(?:[-_A-Z]|$))/.test(key)))
    ) {
      violations.push(formatViolation("single-public-hook-package", `${path} publishes a hook package or hook export`));
    }
    if (
      kind === "smithers" &&
      manifest.name !== "@smthrs/gateway-react" &&
      !permitsWorkflowRenderHooks &&
      !HOOK_EXPORT_EXEMPT_PACKAGES.has(manifest.name)
    ) {
      for (const entryPath of publicEntryPaths(absoluteRoot, path, manifest, files)) {
        const entrySource = readFileSync(join(absoluteRoot, entryPath), "utf8");
        if (publicEntryExportsHook(entryPath, files, sources)) {
          violations.push(
            formatViolation("single-public-hook-package", `${path} root entry ${entryPath} exports a React-style hook`),
          );
        }
        for (const specifier of parseModuleSpecifiers(entrySource)) {
          if (isGatewayReact(specifier) && !entryPath.startsWith("packages/ui/src/smithers/connected/")) {
            violations.push(formatViolation("gateway-react-location", `${entryPath} imports ${specifier}`));
          }
        }
      }
    }
    if (kind === "smithers" && manifest.name === "@smthrs/ui") {
      const baseExport = JSON.stringify(manifest.exports?.["."] ?? "");
      if (baseExport.includes("adapters") || baseExport.includes("smithers/connected")) {
        violations.push(formatViolation("base-ui-export", `${path} base export exposes an adapter or connected layer`));
      }
      for (const [key, value] of Object.entries(manifest.exports ?? {})) {
        const target = JSON.stringify(value);
        if (key === "./*")
          violations.push(formatViolation("explicit-ui-subpaths", `${path} exposes a wildcard subpath`));
        if (target.includes("adapters") && !key.startsWith("./adapters/")) {
          violations.push(formatViolation("explicit-ui-subpaths", `${path} exposes adapters through ${key}`));
        }
      }
    }
    if (
      kind === "smithers" &&
      path.startsWith("packages/") &&
      !["@smthrs/components", "@smthrs/gateway-ui", "@smthrs/ui", "@smthrs/ui-styleguide"].includes(manifest.name)
    ) {
      const packageDirectory = posix.dirname(path);
      const packageSources = sorted([
        ...files.filter((file) => file.startsWith(`${packageDirectory}/src/`)),
        ...publicEntryPaths(absoluteRoot, path, manifest, files),
      ]);
      for (const sourcePath of packageSources) {
        const source = sources.get(sourcePath) ?? readFileSync(join(absoluteRoot, sourcePath), "utf8");
        for (const specifier of parseModuleSpecifiers(source)) {
          if (matchesPrefix(specifier, VISUAL_DEPENDENCY_PREFIXES)) {
            violations.push(formatViolation("single-visual-package", `${sourcePath} imports ${specifier}`));
          }
        }
        if ([".jsx", ".tsx"].includes(extname(sourcePath))) {
          for (const specifier of jsxComponentSpecifiers(source)) {
            if (!specifier.startsWith(".") && !isSmithersPackage(specifier) && basePackage(specifier) !== "react") {
              violations.push(
                formatViolation(
                  "single-visual-package",
                  `${sourcePath} renders a component imported from ${specifier}`,
                ),
              );
            }
          }
        }
        for (const tag of intrinsicVisualTags(source, sourcePath)) {
          violations.push(formatViolation("single-visual-package", `${sourcePath} renders intrinsic <${tag}>`));
        }
      }
    }
  }

  if (kind === "smithers") violations.push(...shadcnViolations(absoluteRoot, files));
  for (const key of INVENTORY_KEYS) inventories[key] = sorted(inventories[key]);
  return {
    version: 1,
    repo: kind,
    inventories,
    violations: sorted(violations),
  };
}

export function baselineFromState(state) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: state.version,
    repo: state.repo,
    policy: {
      mode: "exact-ratchet",
      note: "Inventories and legacy allowlists are sorted snapshots. Remove stale entries; do not add entries for new violations.",
    },
    inventories: state.inventories,
    allowedLegacyViolations: state.violations,
  };
}

function arrayDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

export function checkUiArchitecture({ root, baselinePath, kind = "smithers" }) {
  const absoluteRoot = resolve(root);
  const absoluteBaseline = resolve(absoluteRoot, baselinePath);
  const errors = [];
  let baseline;
  try {
    baseline = readJson(absoluteBaseline);
  } catch (error) {
    return {
      ok: false,
      errors: [`Cannot read ${toPosix(relative(absoluteRoot, absoluteBaseline))}: ${error.message}`],
    };
  }
  const state = collectUiArchitectureState(absoluteRoot, kind);
  if (baseline.version !== state.version || baseline.repo !== kind) {
    errors.push(`Baseline must declare version ${state.version} and repo ${kind}`);
  }
  const allowed = Array.isArray(baseline.allowedLegacyViolations) ? baseline.allowedLegacyViolations : [];
  const newViolations = arrayDifference(state.violations, allowed);
  const staleViolations = arrayDifference(allowed, state.violations);
  for (const violation of newViolations) errors.push(`New architecture violation: ${violation}`);
  for (const violation of staleViolations) errors.push(`Stale legacy allowlist entry (remove it): ${violation}`);
  if (JSON.stringify(allowed) !== JSON.stringify(sorted(allowed))) {
    errors.push("allowedLegacyViolations must be sorted and unique");
  }
  for (const key of INVENTORY_KEYS) {
    const expected = Array.isArray(baseline.inventories?.[key]) ? baseline.inventories[key] : [];
    const actual = state.inventories[key];
    for (const entry of arrayDifference(actual, expected)) errors.push(`Inventory ${key} gained: ${entry}`);
    for (const entry of arrayDifference(expected, actual))
      errors.push(`Inventory ${key} removed (ratchet the baseline): ${entry}`);
    if (JSON.stringify(expected) !== JSON.stringify(sorted(expected))) {
      errors.push(`Inventory ${key} must be sorted and unique`);
    }
  }
  return { ok: errors.length === 0, errors, state };
}

function runCli() {
  const root = process.cwd();
  const kindIndex = process.argv.indexOf("--repo");
  const kind = kindIndex >= 0 ? process.argv[kindIndex + 1] : "smithers";
  const state = collectUiArchitectureState(root, kind);
  if (process.argv.includes("--print-current")) {
    process.stdout.write(`${JSON.stringify(baselineFromState(state), null, 2)}\n`);
    return;
  }
  const baselineIndex = process.argv.indexOf("--baseline");
  const baselinePath = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : "scripts/ui-architecture-baseline.json";
  const result = checkUiArchitecture({ root, baselinePath, kind });
  if (!result.ok) {
    process.stderr.write(`UI architecture guard failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `UI architecture guard passed (${kind}; ${state.violations.length} allowlisted legacy violations).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
